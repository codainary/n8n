-- ==========================================================================
-- Chatbot WhatsApp Automaverso — Fase 1: persistencia y trazabilidad
-- Esquema `chatbot` dentro del Postgres de n8n (n8n-db). Idempotente: se
-- puede re-ejecutar sin perder datos.
--
-- Principios
--   * Fuente de verdad única: chatbot.messages (entrantes + salientes).
--   * Idempotencia: wamid UNIQUE + funciones que hacen INSERT ... ON CONFLICT.
--   * Orden y ráfagas: advisory lock por wa_id + claim_pending() que toma
--     todos los mensajes pendientes del usuario ordenados por timestamp Meta.
--   * Ventana de servicio 24 h: se recalcula con cada entrante; una
--     conversación se cierra al expirar la ventana (close_expired_conversations).
--   * Toda la lógica crítica vive en funciones transaccionales: un nodo n8n
--     = una llamada atómica.
-- ==========================================================================

CREATE SCHEMA IF NOT EXISTS chatbot;
SET search_path = chatbot, public;

-- --------------------------------------------------------------------------
-- Tablas
-- --------------------------------------------------------------------------

-- Auditoría cruda de cada webhook recibido (antes de cualquier lógica)
CREATE TABLE IF NOT EXISTS webhook_events (
  id              bigserial PRIMARY KEY,
  received_at     timestamptz NOT NULL DEFAULT now(),
  signature_valid boolean,
  event_kind      text,                -- messages | statuses | other
  payload         jsonb NOT NULL
);
CREATE INDEX IF NOT EXISTS webhook_events_received_idx ON webhook_events (received_at DESC);

CREATE TABLE IF NOT EXISTS contacts (
  wa_id            text PRIMARY KEY,    -- número en formato E.164 sin '+'
  profile_name     text,
  first_seen_at    timestamptz NOT NULL DEFAULT now(),
  last_inbound_at  timestamptz,
  last_outbound_at timestamptz,
  updated_at       timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS conversations (
  id                        bigserial PRIMARY KEY,
  wa_id                     text NOT NULL REFERENCES contacts (wa_id),
  status                    text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'closed')),
  opened_at                 timestamptz NOT NULL DEFAULT now(),
  opened_by                 text NOT NULL CHECK (opened_by IN ('user', 'business_template')),
  closed_at                 timestamptz,
  close_reason              text CHECK (close_reason IN ('window_expired', 'manual', 'handoff')),
  last_inbound_at           timestamptz,
  service_window_expires_at timestamptz,       -- last_inbound_at + 24 h
  -- Datos de facturación/categoría que Meta informa en los statuses
  meta_conversation_id      text,
  meta_origin_type          text,              -- service | utility | marketing | authentication ...
  meta_pricing_category     text,
  meta_billable             boolean,
  messages_in               integer NOT NULL DEFAULT 0,
  messages_out              integer NOT NULL DEFAULT 0
);
-- Solo una conversación abierta por número
CREATE UNIQUE INDEX IF NOT EXISTS conversations_one_open_per_wa
  ON conversations (wa_id) WHERE status = 'open';
CREATE INDEX IF NOT EXISTS conversations_wa_idx ON conversations (wa_id, opened_at DESC);

CREATE TABLE IF NOT EXISTS media (
  id            bigserial PRIMARY KEY,
  direction     text NOT NULL CHECK (direction IN ('in', 'out')),
  meta_media_id text,                   -- id de Meta (entrante o subido)
  mime_type     text,
  file_name     text,
  sha256        text,
  size_bytes    integer,
  content       bytea,                  -- NULL hasta que se descarga
  storage       text NOT NULL DEFAULT 'postgres',
  downloaded_at timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS media_meta_id_uq ON media (meta_media_id) WHERE meta_media_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS messages (
  id                 bigserial PRIMARY KEY,
  wamid              text NOT NULL UNIQUE,      -- idempotencia
  conversation_id    bigint REFERENCES conversations (id),
  wa_id              text NOT NULL REFERENCES contacts (wa_id),
  direction          text NOT NULL CHECK (direction IN ('in', 'out')),
  msg_type           text NOT NULL,             -- text|audio|image|document|video|sticker|location|contacts|template|...
  text_body          text,
  caption            text,
  media_id           bigint REFERENCES media (id),
  context_wamid      text,                      -- mensaje al que responde (reply de WhatsApp)
  agent_text         text,                      -- representación textual para el agente (texto, transcripción, análisis de imagen)
  meta_timestamp     timestamptz NOT NULL,      -- timestamp de Meta (entrante) o de envío (saliente)
  received_at        timestamptz NOT NULL DEFAULT now(),
  status             text NOT NULL,             -- in: received | out: accepted|sent|delivered|read|failed
  status_at          timestamptz,
  error              jsonb,
  -- Procesamiento (solo entrantes)
  processing_state   text NOT NULL DEFAULT 'pending'
                     CHECK (processing_state IN ('pending', 'processing', 'done', 'skipped', 'failed')),
  processing_attempts integer NOT NULL DEFAULT 0,
  processing_started_at timestamptz,
  processed_at       timestamptz,
  batch_id           uuid,                      -- ráfaga a la que pertenece
  reply_to_batch_id  uuid,                      -- (salientes) ráfaga que responde
  raw                jsonb
);
CREATE INDEX IF NOT EXISTS messages_conv_ts_idx ON messages (conversation_id, meta_timestamp);
CREATE INDEX IF NOT EXISTS messages_wa_ts_idx   ON messages (wa_id, meta_timestamp);
CREATE INDEX IF NOT EXISTS messages_pending_idx ON messages (wa_id, meta_timestamp)
  WHERE direction = 'in' AND processing_state = 'pending';

-- Historial completo de estados (sent/delivered/read/failed); pueden llegar desordenados
CREATE TABLE IF NOT EXISTS message_status_events (
  id                   bigserial PRIMARY KEY,
  wamid                text NOT NULL,
  status               text NOT NULL,
  status_at            timestamptz NOT NULL,
  recipient_id         text,
  meta_conversation_id text,
  meta_origin_type     text,
  meta_pricing_category text,
  meta_billable        boolean,
  errors               jsonb,
  raw                  jsonb,
  received_at          timestamptz NOT NULL DEFAULT now(),
  UNIQUE (wamid, status)
);

-- --------------------------------------------------------------------------
-- Funciones
-- --------------------------------------------------------------------------

-- Rango de estado: solo se avanza, nunca se retrocede (read no vuelve a delivered)
CREATE OR REPLACE FUNCTION status_rank(s text) RETURNS integer
LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE s
    WHEN 'accepted'  THEN 1
    WHEN 'sent'      THEN 2
    WHEN 'delivered' THEN 3
    WHEN 'read'      THEN 4
    WHEN 'failed'    THEN 5
    ELSE 0 END
$$;

-- Devuelve la conversación abierta vigente del número, cerrando la anterior si su
-- ventana de 24 h ya expiró respecto de p_at. Debe llamarse con el lock del wa_id tomado.
CREATE OR REPLACE FUNCTION current_conversation(p_wa_id text, p_at timestamptz, p_opened_by text)
RETURNS TABLE (conversation_id bigint, opened boolean)
LANGUAGE plpgsql SET search_path = chatbot, public AS $$
DECLARE
  v_conv conversations%ROWTYPE;
BEGIN
  SELECT * INTO v_conv FROM conversations c
   WHERE c.wa_id = p_wa_id AND c.status = 'open'
   FOR UPDATE;

  IF FOUND AND v_conv.service_window_expires_at IS NOT NULL
     AND v_conv.service_window_expires_at < p_at THEN
    UPDATE conversations
       SET status = 'closed', closed_at = v_conv.service_window_expires_at,
           close_reason = 'window_expired'
     WHERE id = v_conv.id;
    FOUND := false;
  END IF;

  IF FOUND THEN
    RETURN QUERY SELECT v_conv.id, false;
  ELSE
    RETURN QUERY
      INSERT INTO conversations (wa_id, opened_at, opened_by)
      VALUES (p_wa_id, p_at, p_opened_by)
      RETURNING id, true;
  END IF;
END $$;

-- Ingesta atómica e idempotente de un mensaje entrante.
-- p: {wamid, wa_id, profile_name, type, text, caption, context_wamid, timestamp (epoch s),
--     media: {id, mime_type, file_name, sha256}, raw}
CREATE OR REPLACE FUNCTION ingest_inbound(p jsonb)
RETURNS TABLE (is_new boolean, message_id bigint, conversation_id bigint, conversation_opened boolean)
LANGUAGE plpgsql SET search_path = chatbot, public AS $$
DECLARE
  v_wa     text        := p->>'wa_id';
  v_ts     timestamptz := to_timestamp((p->>'timestamp')::double precision);
  v_msg    bigint;
  v_conv   bigint;
  v_opened boolean;
  v_media  bigint;
BEGIN
  -- Serializa todo lo de este número (ráfagas / reintentos concurrentes de Meta)
  PERFORM pg_advisory_xact_lock(hashtext('wa:' || v_wa));

  -- Duplicado: Meta reenvió el webhook
  SELECT m.id, m.conversation_id INTO v_msg, v_conv FROM messages m WHERE m.wamid = p->>'wamid';
  IF FOUND THEN
    RETURN QUERY SELECT false, v_msg, v_conv, false;
    RETURN;
  END IF;

  INSERT INTO contacts AS c (wa_id, profile_name, last_inbound_at)
  VALUES (v_wa, p->>'profile_name', v_ts)
  ON CONFLICT (wa_id) DO UPDATE
     SET profile_name    = COALESCE(EXCLUDED.profile_name, c.profile_name),
         last_inbound_at = GREATEST(c.last_inbound_at, EXCLUDED.last_inbound_at),
         updated_at      = now();

  SELECT cc.conversation_id, cc.opened INTO v_conv, v_opened
    FROM current_conversation(v_wa, v_ts, 'user') cc;

  IF p ? 'media' AND p->'media'->>'id' IS NOT NULL THEN
    INSERT INTO media (direction, meta_media_id, mime_type, file_name, sha256)
    VALUES ('in', p->'media'->>'id', p->'media'->>'mime_type',
            p->'media'->>'file_name', p->'media'->>'sha256')
    ON CONFLICT (meta_media_id) WHERE meta_media_id IS NOT NULL
      DO UPDATE SET mime_type = EXCLUDED.mime_type
    RETURNING id INTO v_media;
  END IF;

  INSERT INTO messages (wamid, conversation_id, wa_id, direction, msg_type, text_body, caption,
                        media_id, context_wamid, agent_text, meta_timestamp, status, status_at, raw)
  VALUES (p->>'wamid', v_conv, v_wa, 'in', p->>'type', p->>'text', p->>'caption',
          v_media, p->>'context_wamid',
          CASE WHEN p->>'type' = 'text' THEN p->>'text' END,
          v_ts, 'received', now(), p->'raw')
  RETURNING id INTO v_msg;

  -- La ventana de servicio se abre/renueva con cada mensaje del usuario
  UPDATE conversations
     SET last_inbound_at           = GREATEST(COALESCE(last_inbound_at, v_ts), v_ts),
         service_window_expires_at = GREATEST(COALESCE(last_inbound_at, v_ts), v_ts) + interval '24 hours',
         messages_in               = messages_in + 1
   WHERE id = v_conv;

  RETURN QUERY SELECT true, v_msg, v_conv, v_opened;
END $$;

-- Toma (claim) todos los entrantes pendientes de un número como una ráfaga,
-- ordenados por timestamp de Meta. Si otro proceso ya está procesando a ese
-- usuario, devuelve vacío (ese proceso los recogerá en su siguiente vuelta).
-- Recupera ráfagas atascadas en 'processing' por más de p_stale_after.
CREATE OR REPLACE FUNCTION claim_pending(p_wa_id text, p_stale_after interval DEFAULT interval '5 minutes')
RETURNS SETOF messages
LANGUAGE plpgsql SET search_path = chatbot, public AS $$
DECLARE
  v_batch uuid := gen_random_uuid();
BEGIN
  IF NOT pg_try_advisory_xact_lock(hashtext('claim:' || p_wa_id)) THEN
    RETURN;
  END IF;

  -- Si hay una ráfaga viva en proceso para este usuario, no tomar otra (preserva orden)
  IF EXISTS (SELECT 1 FROM messages
              WHERE wa_id = p_wa_id AND direction = 'in' AND processing_state = 'processing'
                AND processing_started_at > now() - p_stale_after) THEN
    RETURN;
  END IF;

  RETURN QUERY
    UPDATE messages m
       SET processing_state      = 'processing',
           processing_started_at = now(),
           processing_attempts   = m.processing_attempts + 1,
           batch_id              = v_batch
     WHERE m.wa_id = p_wa_id AND m.direction = 'in'
       AND (m.processing_state = 'pending'
            OR (m.processing_state = 'processing' AND m.processing_started_at <= now() - p_stale_after))
       AND m.processing_attempts < 3
    RETURNING m.*;
END $$;

-- Cierra una ráfaga: marca sus mensajes como done/failed
CREATE OR REPLACE FUNCTION finish_batch(p_batch uuid, p_state text, p_error jsonb DEFAULT NULL)
RETURNS integer
LANGUAGE sql SET search_path = chatbot, public AS $$
  WITH u AS (
    UPDATE messages
       SET processing_state = p_state, processed_at = now(),
           error = COALESCE(p_error, error)
     WHERE batch_id = p_batch AND processing_state = 'processing'
    RETURNING 1)
  SELECT count(*)::int FROM u
$$;

-- Registra un mensaje saliente aceptado por la Graph API.
-- p: {wamid, wa_id, type, text, caption, media_id (chatbot.media.id), reply_to_batch_id,
--     is_template (bool), raw}
CREATE OR REPLACE FUNCTION register_outbound(p jsonb)
RETURNS TABLE (message_id bigint, conversation_id bigint)
LANGUAGE plpgsql SET search_path = chatbot, public AS $$
DECLARE
  v_wa   text := p->>'wa_id';
  v_conv bigint;
  v_msg  bigint;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext('wa:' || v_wa));

  INSERT INTO contacts (wa_id, last_outbound_at) VALUES (v_wa, now())
  ON CONFLICT (wa_id) DO UPDATE SET last_outbound_at = now(), updated_at = now();

  IF COALESCE((p->>'is_template')::boolean, false) THEN
    -- Solo una plantilla puede (re)abrir conversación fuera de la ventana de 24 h
    SELECT cc.conversation_id INTO v_conv
      FROM current_conversation(v_wa, now(), 'business_template') cc;
  ELSE
    -- Mensaje libre: responde dentro de la conversación vigente (o la última)
    SELECT c.id INTO v_conv FROM conversations c
     WHERE c.wa_id = v_wa
     ORDER BY (c.status = 'open') DESC, c.opened_at DESC
     LIMIT 1;
  END IF;

  INSERT INTO messages (wamid, conversation_id, wa_id, direction, msg_type, text_body, caption,
                        media_id, agent_text, meta_timestamp, status, status_at,
                        processing_state, reply_to_batch_id, raw)
  VALUES (p->>'wamid', v_conv, v_wa, 'out', p->>'type', p->>'text', p->>'caption',
          (p->>'media_id')::bigint, COALESCE(p->>'agent_text', p->>'text'), now(),
          'accepted', now(), 'done', (p->>'reply_to_batch_id')::uuid, p->'raw')
  ON CONFLICT (wamid) DO NOTHING
  RETURNING id INTO v_msg;

  IF v_msg IS NOT NULL THEN
    UPDATE conversations SET messages_out = messages_out + 1 WHERE id = v_conv;
  END IF;

  RETURN QUERY SELECT v_msg, v_conv;
END $$;

-- Aplica un status de Meta (sent/delivered/read/failed). Idempotente y tolerante al desorden.
-- p: un elemento de value.statuses[] tal cual llega de Meta.
CREATE OR REPLACE FUNCTION apply_status(p jsonb)
RETURNS boolean
LANGUAGE plpgsql SET search_path = chatbot, public AS $$
DECLARE
  v_ts  timestamptz := to_timestamp((p->>'timestamp')::double precision);
  v_new boolean;
BEGIN
  INSERT INTO message_status_events (wamid, status, status_at, recipient_id, meta_conversation_id,
         meta_origin_type, meta_pricing_category, meta_billable, errors, raw)
  VALUES (p->>'id', p->>'status', v_ts, p->>'recipient_id',
          p->'conversation'->>'id', p->'conversation'->'origin'->>'type',
          p->'pricing'->>'category', (p->'pricing'->>'billable')::boolean,
          p->'errors', p)
  ON CONFLICT (wamid, status) DO NOTHING
  RETURNING true INTO v_new;

  UPDATE messages
     SET status    = p->>'status',
         status_at = v_ts,
         error     = CASE WHEN p ? 'errors' THEN p->'errors' ELSE error END
   WHERE wamid = p->>'id'
     AND status_rank(p->>'status') > status_rank(status);

  -- Categoría/facturación de la conversación según Meta
  UPDATE conversations c
     SET meta_conversation_id  = COALESCE(c.meta_conversation_id, p->'conversation'->>'id'),
         meta_origin_type      = COALESCE(c.meta_origin_type, p->'conversation'->'origin'->>'type'),
         meta_pricing_category = COALESCE(c.meta_pricing_category, p->'pricing'->>'category'),
         meta_billable         = COALESCE(c.meta_billable, (p->'pricing'->>'billable')::boolean)
    FROM messages m
   WHERE m.wamid = p->>'id' AND c.id = m.conversation_id
     AND (p ? 'conversation' OR p ? 'pricing');

  RETURN COALESCE(v_new, false);
END $$;

-- Cierra conversaciones cuya ventana de 24 h expiró (para un Schedule Trigger)
CREATE OR REPLACE FUNCTION close_expired_conversations()
RETURNS integer
LANGUAGE sql SET search_path = chatbot, public AS $$
  WITH u AS (
    UPDATE conversations
       SET status = 'closed',
           closed_at = COALESCE(service_window_expires_at, opened_at + interval '24 hours'),
           close_reason = 'window_expired'
     WHERE status = 'open'
       AND (service_window_expires_at < now()
            -- abierta por plantilla y el usuario nunca respondió
            OR (service_window_expires_at IS NULL AND opened_at < now() - interval '24 hours'))
    RETURNING 1)
  SELECT count(*)::int FROM u
$$;

-- ¿Se puede responder con mensaje libre o hace falta plantilla?
CREATE OR REPLACE FUNCTION window_state(p_wa_id text)
RETURNS TABLE (can_send_free_form boolean, expires_at timestamptz, conversation_id bigint)
LANGUAGE sql STABLE SET search_path = chatbot, public AS $$
  SELECT COALESCE(c.service_window_expires_at > now(), false), c.service_window_expires_at, c.id
    FROM contacts ct
    LEFT JOIN conversations c ON c.wa_id = ct.wa_id AND c.status = 'open'
   WHERE ct.wa_id = p_wa_id
$$;

-- Contexto para el agente: últimos N mensajes del número (todas sus conversaciones),
-- en orden cronológico, con texto utilizable. Reconstruible en cualquier momento.
CREATE OR REPLACE FUNCTION agent_context(p_wa_id text, p_limit integer DEFAULT 20)
RETURNS TABLE (role text, content text, msg_type text, at timestamptz)
LANGUAGE sql STABLE SET search_path = chatbot, public AS $$
  SELECT * FROM (
    SELECT CASE m.direction WHEN 'in' THEN 'user' ELSE 'assistant' END,
           COALESCE(m.agent_text, m.text_body, m.caption, '[' || m.msg_type || ']'),
           m.msg_type, m.meta_timestamp
      FROM messages m
     WHERE m.wa_id = p_wa_id
       AND (m.direction = 'out' OR m.processing_state IN ('done', 'processing'))
     ORDER BY m.meta_timestamp DESC, m.id DESC
     LIMIT p_limit) t
  ORDER BY t.meta_timestamp ASC
$$;

-- --------------------------------------------------------------------------
-- Vista de trazabilidad: línea de tiempo completa de una conversación
-- --------------------------------------------------------------------------
CREATE OR REPLACE VIEW v_timeline AS
SELECT c.id            AS conversation_id,
       c.wa_id,
       ct.profile_name,
       c.status        AS conversation_status,
       c.opened_at, c.opened_by, c.closed_at, c.close_reason,
       c.service_window_expires_at,
       c.meta_pricing_category,
       m.id            AS message_id,
       m.wamid,
       m.direction,
       m.msg_type,
       COALESCE(m.text_body, m.caption, m.agent_text) AS content,
       m.meta_timestamp,
       m.status        AS delivery_status,
       m.status_at,
       m.processing_state,
       md.mime_type, md.file_name, md.size_bytes,
       (md.content IS NOT NULL) AS media_stored
  FROM conversations c
  JOIN contacts ct ON ct.wa_id = c.wa_id
  LEFT JOIN messages m  ON m.conversation_id = c.id
  LEFT JOIN media    md ON md.id = m.media_id;
