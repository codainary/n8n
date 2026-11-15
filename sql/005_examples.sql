-- ==========================================================================
-- Videos de ejemplo del bot ("Ver ejemplos").
-- Fuente: carpeta de Drive «Automaverso - Ejemplos del bot (videos)» + Sheet «_Catálogo de ejemplos».
-- EX · 1 sincroniza Drive → Meta (sube cada video una vez y guarda el media_id, que vence a los 30 días).
-- TOOL · Enviar ejemplo elige el siguiente video no visto por el usuario.
-- Idempotente.
-- ==========================================================================

CREATE TABLE IF NOT EXISTS chatbot.examples (
  id               serial PRIMARY KEY,
  drive_file_id    text NOT NULL UNIQUE,
  file_name        text NOT NULL,
  mime_type        text,
  md5              text,
  size_bytes       bigint,
  title            text,
  description      text,
  topic            text,                  -- palabras clave de industria/tema (para elegir según el cliente)
  sort_order       integer NOT NULL DEFAULT 100,
  active           boolean NOT NULL DEFAULT false,   -- en el catálogo y marcado como activo
  in_drive         boolean NOT NULL DEFAULT true,
  meta_media_id    text,                  -- id del video subido a WhatsApp (vence a los 30 días)
  meta_uploaded_at timestamptz,
  last_error       text,
  updated_at       timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS chatbot.example_views (
  wa_id      text NOT NULL,
  example_id integer NOT NULL REFERENCES chatbot.examples (id) ON DELETE CASCADE,
  wamid      text,
  sent_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (wa_id, example_id)
);

-- Texto normalizado para comparar temas (minúsculas, sin tildes)
CREATE OR REPLACE FUNCTION chatbot.norm(p text) RETURNS text
LANGUAGE sql IMMUTABLE AS $$
  SELECT translate(lower(COALESCE(p, '')), 'áéíóúüñ', 'aeiouun')
$$;

-- Planifica la sincronización.
-- p_files:   [{id, name, mimeType, md5Checksum, size}] de la carpeta de Drive
-- p_catalog: filas del Sheet [{archivo, titulo, descripcion, tema, activo, orden}]
-- Devuelve los videos que hay que (re)subir a Meta.
CREATE OR REPLACE FUNCTION chatbot.examples_plan(p_files jsonb, p_catalog jsonb)
RETURNS TABLE (id integer, drive_file_id text, file_name text, mime_type text, size_bytes bigint)
LANGUAGE plpgsql SET search_path = chatbot, public AS $$
#variable_conflict use_column
BEGIN
  WITH f AS (
    SELECT x->>'id' AS fid, x->>'name' AS name, x->>'mimeType' AS mime,
           x->>'md5Checksum' AS md5, NULLIF(x->>'size', '')::bigint AS size
      FROM jsonb_array_elements(COALESCE(p_files, '[]')) x
     WHERE x->>'mimeType' LIKE 'video/%' AND left(x->>'name', 1) <> '_'
  ), c AS (
    SELECT DISTINCT ON (lower(trim(r->>'archivo')))
           lower(trim(r->>'archivo')) AS archivo, NULLIF(trim(r->>'titulo'), '') AS titulo,
           NULLIF(trim(r->>'descripcion'), '') AS descripcion, NULLIF(trim(r->>'tema'), '') AS tema,
           norm(trim(r->>'activo')) IN ('si', 'yes', 'true', 'x', '1', 'activo') AS activo,
           CASE WHEN trim(r->>'orden') ~ '^\d+$' THEN trim(r->>'orden')::int ELSE 100 END AS orden
      FROM jsonb_array_elements(COALESCE(p_catalog, '[]')) r
     WHERE COALESCE(trim(r->>'archivo'), '') <> ''
  )
  INSERT INTO examples AS e (drive_file_id, file_name, mime_type, md5, size_bytes, title, description,
                             topic, sort_order, active, in_drive, updated_at)
  SELECT f.fid, f.name, f.mime, f.md5, f.size, c.titulo, c.descripcion, c.tema,
         COALESCE(c.orden, 100), COALESCE(c.activo, false) AND c.titulo IS NOT NULL, true, now()
    FROM f LEFT JOIN c ON c.archivo = lower(f.name)
  ON CONFLICT (drive_file_id) DO UPDATE
     SET file_name = EXCLUDED.file_name, mime_type = EXCLUDED.mime_type, size_bytes = EXCLUDED.size_bytes,
         title = EXCLUDED.title, description = EXCLUDED.description, topic = EXCLUDED.topic,
         sort_order = EXCLUDED.sort_order, active = EXCLUDED.active, in_drive = true,
         -- si el archivo cambió, hay que volver a subirlo
         meta_media_id = CASE WHEN e.md5 IS DISTINCT FROM EXCLUDED.md5 THEN NULL ELSE e.meta_media_id END,
         md5 = EXCLUDED.md5,
         updated_at = now();

  -- Videos que ya no están en la carpeta
  UPDATE examples e SET in_drive = false, active = false, meta_media_id = NULL, updated_at = now()
   WHERE e.in_drive
     AND NOT EXISTS (SELECT 1 FROM jsonb_array_elements(COALESCE(p_files, '[]')) x WHERE x->>'id' = e.drive_file_id);

  -- WhatsApp no acepta videos de más de 16 MB
  UPDATE examples e SET last_error = 'El video pesa más de 16 MB (límite de WhatsApp): comprímelo y vuelve a subirlo.'
   WHERE e.active AND e.size_bytes > 16 * 1024 * 1024;

  RETURN QUERY
    SELECT e.id, e.drive_file_id, e.file_name, e.mime_type, e.size_bytes
      FROM examples e
     WHERE e.active AND COALESCE(e.size_bytes, 0) <= 16 * 1024 * 1024
       AND (e.meta_media_id IS NULL OR e.meta_uploaded_at < now() - interval '25 days')
     ORDER BY e.sort_order, e.id;
END $$;

-- Resultado de subir un video a Meta
CREATE OR REPLACE FUNCTION chatbot.example_uploaded(p_id integer, p_media_id text, p_error text)
RETURNS boolean
LANGUAGE sql SET search_path = chatbot, public AS $$
  UPDATE examples
     SET meta_media_id    = CASE WHEN COALESCE(p_media_id, '') <> '' THEN p_media_id ELSE meta_media_id END,
         meta_uploaded_at = CASE WHEN COALESCE(p_media_id, '') <> '' THEN now() ELSE meta_uploaded_at END,
         last_error       = NULLIF(p_error, ''),
         updated_at       = now()
   WHERE id = p_id
  RETURNING COALESCE(p_error, '') = ''
$$;

-- Siguiente video para un usuario: no visto, preferentemente del tema pedido.
-- remaining = cuántos quedan sin ver después de este.
CREATE OR REPLACE FUNCTION chatbot.next_example(p_wa_id text, p_topic text DEFAULT NULL)
RETURNS TABLE (example_id integer, title text, caption text, meta_media_id text, remaining integer, total integer)
LANGUAGE sql STABLE SET search_path = chatbot, public AS $$
  WITH ready AS (
    SELECT e.* FROM examples e
     WHERE e.active AND e.meta_media_id IS NOT NULL
       AND e.meta_uploaded_at > now() - interval '29 days'
  ), unseen AS (
    SELECT r.*,
           (SELECT count(*) FROM regexp_split_to_table(norm(p_topic), '[^a-z0-9]+') w
             WHERE length(w) >= 4
               AND position(w IN norm(concat_ws(' ', r.topic, r.title, r.description))) > 0) AS score
      FROM ready r
     WHERE NOT EXISTS (SELECT 1 FROM example_views v WHERE v.wa_id = p_wa_id AND v.example_id = r.id)
  ), pick AS (
    SELECT * FROM unseen ORDER BY score DESC, sort_order, id LIMIT 1
  )
  SELECT p.id, p.title,
         left('*Caso: ' || p.title || '*' || COALESCE(E'\n\n' || p.description, ''), 1024),
         p.meta_media_id,
         (SELECT count(*)::int FROM unseen) - 1,
         (SELECT count(*)::int FROM ready)
    FROM pick p
  UNION ALL
  -- Sin videos por ver: una fila vacía con el total, para que el flujo sepa por qué
  SELECT NULL, NULL, NULL, NULL, 0, (SELECT count(*)::int FROM ready)
   WHERE NOT EXISTS (SELECT 1 FROM pick)
$$;

-- Registra que el usuario recibió un video (y quita el media_id si Meta lo rechazó)
CREATE OR REPLACE FUNCTION chatbot.example_sent(p_wa_id text, p_example_id integer, p_wamid text)
RETURNS boolean
LANGUAGE sql SET search_path = chatbot, public AS $$
  INSERT INTO example_views (wa_id, example_id, wamid) VALUES (p_wa_id, p_example_id, p_wamid)
  ON CONFLICT (wa_id, example_id) DO UPDATE SET wamid = EXCLUDED.wamid, sent_at = now()
  RETURNING true
$$;

CREATE OR REPLACE FUNCTION chatbot.example_media_invalid(p_example_id integer, p_error text)
RETURNS boolean
LANGUAGE sql SET search_path = chatbot, public AS $$
  UPDATE examples SET meta_media_id = NULL, last_error = left(p_error, 500), updated_at = now()
   WHERE id = p_example_id
  RETURNING true
$$;

-- Estado para revisar de un vistazo
CREATE OR REPLACE VIEW chatbot.v_examples AS
SELECT id, sort_order, title, file_name, active, in_drive,
       round(size_bytes / 1048576.0, 1) AS size_mb,
       meta_media_id IS NOT NULL AS ready, meta_uploaded_at, last_error,
       (SELECT count(*) FROM chatbot.example_views v WHERE v.example_id = e.id) AS views
  FROM chatbot.examples e
 ORDER BY sort_order, id;
