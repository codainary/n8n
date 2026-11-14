-- ==========================================================================
-- Base de conocimiento (RAG) — registro de sincronización Drive → Pinecone
-- Esquema `kb` en el Postgres de n8n. Idempotente (re-ejecutable).
--
-- kb.files      : estado de cada archivo indexado (versión, vectores, namespace)
-- kb.sync_runs  : una fila por ejecución de la sincronización
-- kb.sync_events: qué se hizo con cada archivo en cada ejecución
-- ==========================================================================

CREATE SCHEMA IF NOT EXISTS kb;

CREATE TABLE IF NOT EXISTS kb.files (
  file_id          text PRIMARY KEY,           -- id de Google Drive
  name             text NOT NULL,
  mime_type        text NOT NULL,
  category         text NOT NULL,              -- = namespace de Pinecone (subcarpeta)
  modified_time    timestamptz,
  version          bigint,                     -- version de Drive (sube con cada cambio)
  vector_ids       text[] NOT NULL DEFAULT '{}',
  chunk_count      integer NOT NULL DEFAULT 0,
  status           text NOT NULL DEFAULT 'pending'
                   CHECK (status IN ('pending', 'indexed', 'error', 'deleted', 'unsupported')),
  last_error       text,
  first_indexed_at timestamptz,
  last_indexed_at  timestamptz,
  deleted_at       timestamptz,
  updated_at       timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS kb.sync_runs (
  id          bigserial PRIMARY KEY,
  trigger     text NOT NULL,                   -- schedule | manual | reindex
  full_reindex boolean NOT NULL DEFAULT false,
  status      text NOT NULL DEFAULT 'running' CHECK (status IN ('running', 'ok', 'partial', 'error', 'skipped')),
  started_at  timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz,
  files_seen  integer,
  added       integer NOT NULL DEFAULT 0,
  updated     integer NOT NULL DEFAULT 0,
  deleted     integer NOT NULL DEFAULT 0,
  unchanged   integer NOT NULL DEFAULT 0,
  errors      integer NOT NULL DEFAULT 0,
  note        text
);

CREATE TABLE IF NOT EXISTS kb.sync_events (
  id        bigserial PRIMARY KEY,
  run_id    bigint REFERENCES kb.sync_runs (id),
  file_id   text NOT NULL,
  file_name text,
  action    text NOT NULL,                     -- add | update | delete | unsupported
  status    text NOT NULL,                     -- ok | error
  chunks    integer,
  error     text,
  at        timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS kb_sync_events_run_idx ON kb.sync_events (run_id);

-- --------------------------------------------------------------------------
-- Abre una ejecución. Devuelve NULL si ya hay otra corriendo (< 15 min),
-- para que dos sincronizaciones nunca se pisen.
CREATE OR REPLACE FUNCTION kb.start_run(p_trigger text, p_full boolean)
RETURNS bigint
LANGUAGE plpgsql SET search_path = kb, public AS $$
DECLARE v_id bigint;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext('kb:start_run'));
  -- Ejecuciones colgadas (n8n se reinició a mitad) se dan por fallidas
  UPDATE sync_runs SET status = 'error', finished_at = now(), note = 'abandonada (timeout)'
   WHERE status = 'running' AND started_at < now() - interval '15 minutes';
  IF EXISTS (SELECT 1 FROM sync_runs WHERE status = 'running') THEN
    RETURN NULL;
  END IF;
  INSERT INTO sync_runs (trigger, full_reindex) VALUES (p_trigger, p_full) RETURNING id INTO v_id;
  RETURN v_id;
END $$;

-- Compara el listado actual de Drive con el registro y decide la acción por archivo.
-- p_files: [{file_id, name, mime_type, category, modified_time, version}]
-- Salvaguarda: si el listado viene vacío y hay archivos indexados, no borra nada.
CREATE OR REPLACE FUNCTION kb.plan_sync(p_run_id bigint, p_files jsonb, p_full boolean)
RETURNS TABLE (file_id text, name text, mime_type text, category text, modified_time timestamptz,
               version bigint, action text, old_category text, old_vector_ids text[])
LANGUAGE plpgsql SET search_path = kb, public AS $$
DECLARE v_seen int := jsonb_array_length(COALESCE(p_files, '[]'));
BEGIN
  UPDATE sync_runs SET files_seen = v_seen WHERE id = p_run_id;

  IF v_seen = 0 AND EXISTS (SELECT 1 FROM files f WHERE f.status = 'indexed') THEN
    RAISE EXCEPTION 'Listado de Drive vacío pero hay archivos indexados: no se borra nada (posible fallo de acceso).';
  END IF;

  RETURN QUERY
  WITH cur AS (
    SELECT x->>'file_id' AS file_id, x->>'name' AS name, x->>'mime_type' AS mime_type,
           x->>'category' AS category, (x->>'modified_time')::timestamptz AS modified_time,
           (x->>'version')::bigint AS version
      FROM jsonb_array_elements(COALESCE(p_files, '[]')) x
     WHERE left(x->>'name', 1) <> '_'
  ), supported AS (
    SELECT c.*, c.mime_type IN ('application/vnd.google-apps.document',
                                'application/vnd.google-apps.spreadsheet',
                                'application/pdf') AS ok
      FROM cur c
  )
  -- Nuevos / modificados / sin cambios / no soportados
  SELECT s.file_id, s.name, s.mime_type, s.category, s.modified_time, s.version,
         CASE WHEN NOT s.ok THEN 'unsupported'
              WHEN f.file_id IS NULL OR f.status IN ('deleted', 'pending') THEN 'add'
              WHEN p_full OR f.status = 'error' OR f.version IS DISTINCT FROM s.version
                   OR f.category IS DISTINCT FROM s.category OR f.name IS DISTINCT FROM s.name THEN 'update'
              ELSE 'unchanged' END,
         f.category, f.vector_ids
    FROM supported s
    LEFT JOIN files f ON f.file_id = s.file_id
  UNION ALL
  -- Eliminados de Drive (o movidos fuera de la carpeta, o renombrados con "_")
  SELECT f.file_id, f.name, f.mime_type, f.category, f.modified_time, f.version,
         'delete', f.category, f.vector_ids
    FROM files f
   WHERE f.status IN ('indexed', 'error', 'unsupported')
     AND NOT EXISTS (SELECT 1 FROM cur c WHERE c.file_id = f.file_id);
END $$;

-- Registra un archivo indexado. Devuelve los vectores viejos que ya no existen
-- (por cambio de namespace o porque el archivo tiene menos fragmentos) para borrarlos.
CREATE OR REPLACE FUNCTION kb.mark_indexed(p_run_id bigint, p_file jsonb, p_vector_ids text[], p_action text)
RETURNS TABLE (stale_namespace text, stale_ids text[])
LANGUAGE plpgsql SET search_path = kb, public AS $$
DECLARE v_old files%ROWTYPE;
BEGIN
  SELECT * INTO v_old FROM files WHERE file_id = p_file->>'file_id' FOR UPDATE;

  INSERT INTO files (file_id, name, mime_type, category, modified_time, version, vector_ids, chunk_count,
                     status, last_error, first_indexed_at, last_indexed_at, deleted_at, updated_at)
  VALUES (p_file->>'file_id', p_file->>'name', p_file->>'mime_type', p_file->>'category',
          (p_file->>'modified_time')::timestamptz, (p_file->>'version')::bigint, p_vector_ids,
          COALESCE(array_length(p_vector_ids, 1), 0), 'indexed', NULL, now(), now(), NULL, now())
  ON CONFLICT (file_id) DO UPDATE SET
     name = EXCLUDED.name, mime_type = EXCLUDED.mime_type, category = EXCLUDED.category,
     modified_time = EXCLUDED.modified_time, version = EXCLUDED.version,
     vector_ids = EXCLUDED.vector_ids, chunk_count = EXCLUDED.chunk_count,
     status = 'indexed', last_error = NULL, last_indexed_at = now(), deleted_at = NULL, updated_at = now();

  INSERT INTO sync_events (run_id, file_id, file_name, action, status, chunks)
  VALUES (p_run_id, p_file->>'file_id', p_file->>'name', p_action, 'ok', COALESCE(array_length(p_vector_ids, 1), 0));

  IF v_old.file_id IS NOT NULL THEN
    IF v_old.category IS DISTINCT FROM p_file->>'category' THEN
      RETURN QUERY SELECT v_old.category, v_old.vector_ids;            -- cambió de carpeta: borrar todos en el namespace viejo
    ELSE
      RETURN QUERY SELECT v_old.category,
                          ARRAY(SELECT unnest(v_old.vector_ids) EXCEPT SELECT unnest(p_vector_ids));
    END IF;
  ELSE
    RETURN QUERY SELECT NULL::text, '{}'::text[];
  END IF;
END $$;

CREATE OR REPLACE FUNCTION kb.mark_deleted(p_run_id bigint, p_file_id text)
RETURNS void
LANGUAGE sql SET search_path = kb, public AS $$
  INSERT INTO sync_events (run_id, file_id, file_name, action, status, chunks)
  SELECT p_run_id, file_id, name, 'delete', 'ok', chunk_count FROM files WHERE file_id = p_file_id;
  UPDATE files SET status = 'deleted', vector_ids = '{}', chunk_count = 0, deleted_at = now(), updated_at = now()
   WHERE file_id = p_file_id;
$$;

CREATE OR REPLACE FUNCTION kb.mark_error(p_run_id bigint, p_file jsonb, p_action text, p_error text)
RETURNS void
LANGUAGE sql SET search_path = kb, public AS $$
  INSERT INTO files (file_id, name, mime_type, category, modified_time, version, status, last_error, updated_at)
  VALUES (p_file->>'file_id', p_file->>'name', p_file->>'mime_type', p_file->>'category',
          (p_file->>'modified_time')::timestamptz, NULL, 'error', left(p_error, 2000), now())
  ON CONFLICT (file_id) DO UPDATE SET status = CASE WHEN files.vector_ids = '{}' THEN 'error' ELSE files.status END,
         last_error = left(p_error, 2000), updated_at = now(), version = NULL;  -- version NULL fuerza reintento
  INSERT INTO sync_events (run_id, file_id, file_name, action, status, error)
  VALUES (p_run_id, p_file->>'file_id', p_file->>'name', p_action, 'error', left(p_error, 2000));
$$;

CREATE OR REPLACE FUNCTION kb.mark_unsupported(p_run_id bigint, p_file jsonb)
RETURNS void
LANGUAGE sql SET search_path = kb, public AS $$
  INSERT INTO files (file_id, name, mime_type, category, modified_time, version, status, updated_at)
  VALUES (p_file->>'file_id', p_file->>'name', p_file->>'mime_type', p_file->>'category',
          (p_file->>'modified_time')::timestamptz, (p_file->>'version')::bigint, 'unsupported', now())
  ON CONFLICT (file_id) DO UPDATE SET name = EXCLUDED.name, status = 'unsupported', updated_at = now();
  INSERT INTO sync_events (run_id, file_id, file_name, action, status, error)
  SELECT p_run_id, p_file->>'file_id', p_file->>'name', 'unsupported', 'ok', p_file->>'mime_type'
   WHERE NOT EXISTS (SELECT 1 FROM files WHERE file_id = p_file->>'file_id' AND status = 'unsupported'
                       AND updated_at < now() - interval '1 second');
$$;

-- Cierra la ejecución con los totales de sus eventos
CREATE OR REPLACE FUNCTION kb.finish_run(p_run_id bigint, p_unchanged integer)
RETURNS kb.sync_runs
LANGUAGE sql SET search_path = kb, public AS $$
  UPDATE sync_runs r SET
     added     = (SELECT count(*) FROM sync_events e WHERE e.run_id = r.id AND e.action = 'add'    AND e.status = 'ok'),
     updated   = (SELECT count(*) FROM sync_events e WHERE e.run_id = r.id AND e.action = 'update' AND e.status = 'ok'),
     deleted   = (SELECT count(*) FROM sync_events e WHERE e.run_id = r.id AND e.action = 'delete' AND e.status = 'ok'),
     errors    = (SELECT count(*) FROM sync_events e WHERE e.run_id = r.id AND e.status = 'error'),
     unchanged = COALESCE(p_unchanged, 0),
     status    = CASE WHEN EXISTS (SELECT 1 FROM sync_events e WHERE e.run_id = r.id AND e.status = 'error')
                      THEN 'partial' ELSE 'ok' END,
     finished_at = now()
   WHERE r.id = p_run_id
  RETURNING r.*
$$;

-- Vista de estado para consultar rápido qué hay indexado
CREATE OR REPLACE VIEW kb.v_status AS
SELECT f.category, f.name, f.status, f.chunk_count, f.version, f.modified_time, f.last_indexed_at, f.last_error
  FROM kb.files f
 ORDER BY f.category, f.name;

-- Registra el resultado de procesar un archivo: si hubo error lo anota; si no, no hace nada
-- (los éxitos ya los registra mark_indexed / mark_deleted dentro de KB · 2).
CREATE OR REPLACE FUNCTION kb.log_result(p_run_id bigint, p_file jsonb, p_action text, p_error text)
RETURNS boolean
LANGUAGE plpgsql SET search_path = kb, public AS $$
BEGIN
  IF COALESCE(p_error, '') = '' OR p_file->>'file_id' IS NULL THEN
    RETURN false;
  END IF;
  PERFORM mark_error(p_run_id, p_file, p_action, p_error);
  RETURN true;
END $$;

-- Cierra una ejecución que falló antes de procesar archivos (p.ej. Drive no respondió)
CREATE OR REPLACE FUNCTION kb.fail_run(p_run_id bigint, p_note text)
RETURNS kb.sync_runs
LANGUAGE sql SET search_path = kb, public AS $$
  UPDATE sync_runs SET status = 'error', finished_at = now(), note = left(p_note, 2000)
   WHERE id = p_run_id RETURNING *
$$;
