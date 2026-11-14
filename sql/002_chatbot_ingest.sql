-- ==========================================================================
-- Chatbot WhatsApp — Fase 1: ingesta de webhooks de Meta
-- Una llamada = una transacción: firma -> auditoría -> mensajes -> statuses.
-- Idempotente (re-ejecutable).
-- ==========================================================================

CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- Configuración/secretos del bot. Los valores se cargan fuera de git
-- (ver scripts/apply-sql-remote.mjs + .env); aquí solo la estructura.
CREATE TABLE IF NOT EXISTS chatbot.app_config (
  key        text PRIMARY KEY,
  value      text NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);
REVOKE ALL ON chatbot.app_config FROM PUBLIC;

CREATE OR REPLACE FUNCTION chatbot.config(p_key text) RETURNS text
LANGUAGE sql STABLE SET search_path = chatbot, public AS $$
  SELECT value FROM app_config WHERE key = p_key
$$;

-- Handshake GET de Meta (hub.mode=subscribe & hub.verify_token)
CREATE OR REPLACE FUNCTION chatbot.verify_subscription(p_mode text, p_token text) RETURNS boolean
LANGUAGE sql STABLE SET search_path = chatbot, public AS $$
  SELECT p_mode = 'subscribe' AND p_token IS NOT NULL AND p_token = config('wa_verify_token')
$$;

-- Tipos que no deben generar respuesta del bot
CREATE OR REPLACE FUNCTION chatbot.is_silent_type(p_type text) RETURNS boolean
LANGUAGE sql IMMUTABLE AS $$
  SELECT p_type IN ('reaction', 'system', 'ephemeral', 'request_welcome', 'errors')
$$;

-- Procesa el cuerpo crudo de un webhook POST de Meta.
-- p_raw: cuerpo exacto (para la firma). p_signature: cabecera X-Hub-Signature-256.
-- Devuelve: {valid, event_id, messages_new, messages_duplicate, statuses, wa_ids:[...]}
CREATE OR REPLACE FUNCTION chatbot.handle_webhook(p_raw text, p_signature text)
RETURNS jsonb
LANGUAGE plpgsql SET search_path = chatbot, public AS $$
DECLARE
  v_secret   text := config('wa_app_secret');
  v_expected text;
  v_valid    boolean;
  v_payload  jsonb;
  v_event    bigint;
  v_entry    jsonb;
  v_change   jsonb;
  v_value    jsonb;
  v_msg      jsonb;
  v_status   jsonb;
  v_type     text;
  v_body     jsonb;
  v_name     text;
  v_res      record;
  v_new      int := 0;
  v_dup      int := 0;
  v_st       int := 0;
  v_wa_ids   text[] := '{}';
BEGIN
  IF v_secret IS NULL THEN
    RAISE EXCEPTION 'chatbot.app_config sin wa_app_secret';
  END IF;

  v_expected := 'sha256=' || encode(hmac(convert_to(p_raw, 'UTF8'), convert_to(v_secret, 'UTF8'), 'sha256'), 'hex');
  v_valid    := p_signature IS NOT NULL AND lower(p_signature) = v_expected;

  BEGIN
    v_payload := p_raw::jsonb;
  EXCEPTION WHEN others THEN
    v_payload := jsonb_build_object('_unparseable', left(p_raw, 10000));
  END;

  INSERT INTO webhook_events (signature_valid, event_kind, payload)
  VALUES (v_valid,
          CASE WHEN v_payload::text LIKE '%"messages"%' THEN 'messages'
               WHEN v_payload::text LIKE '%"statuses"%' THEN 'statuses'
               ELSE 'other' END,
          v_payload)
  RETURNING id INTO v_event;

  -- Firma inválida: se audita pero no se procesa
  IF NOT v_valid THEN
    RETURN jsonb_build_object('valid', false, 'event_id', v_event);
  END IF;

  FOR v_entry IN SELECT * FROM jsonb_array_elements(COALESCE(v_payload->'entry', '[]')) LOOP
    FOR v_change IN SELECT * FROM jsonb_array_elements(COALESCE(v_entry->'changes', '[]')) LOOP
      CONTINUE WHEN v_change->>'field' IS DISTINCT FROM 'messages';
      v_value := v_change->'value';

      -- Mensajes entrantes
      FOR v_msg IN SELECT * FROM jsonb_array_elements(COALESCE(v_value->'messages', '[]')) LOOP
        v_type := v_msg->>'type';
        v_body := v_msg->v_type;   -- objeto específico del tipo (text, audio, image, ...)
        SELECT c->'profile'->>'name' INTO v_name
          FROM jsonb_array_elements(COALESCE(v_value->'contacts', '[]')) c
         WHERE c->>'wa_id' = v_msg->>'from' LIMIT 1;

        SELECT * INTO v_res FROM ingest_inbound(jsonb_strip_nulls(jsonb_build_object(
          'wamid',         v_msg->>'id',
          'wa_id',         v_msg->>'from',
          'profile_name',  v_name,
          'type',          v_type,
          'text',          CASE v_type
                             WHEN 'text'        THEN v_body->>'body'
                             WHEN 'button'      THEN v_body->>'text'
                             WHEN 'interactive' THEN COALESCE(v_body->'button_reply'->>'title', v_body->'list_reply'->>'title')
                           END,
          'caption',       v_body->>'caption',
          'context_wamid', v_msg->'context'->>'id',
          'timestamp',     v_msg->>'timestamp',
          'media',         CASE WHEN v_type IN ('audio', 'image', 'document', 'video', 'sticker')
                             THEN jsonb_build_object('id', v_body->>'id', 'mime_type', v_body->>'mime_type',
                                                     'file_name', v_body->>'filename', 'sha256', v_body->>'sha256')
                           END,
          'raw',           v_msg)));

        IF v_res.is_new THEN
          v_new := v_new + 1;
          IF is_silent_type(v_type) THEN
            UPDATE messages SET processing_state = 'skipped', processed_at = now() WHERE id = v_res.message_id;
          ELSIF NOT (v_msg->>'from' = ANY (v_wa_ids)) THEN
            v_wa_ids := v_wa_ids || (v_msg->>'from');
          END IF;
        ELSE
          v_dup := v_dup + 1;
        END IF;
      END LOOP;

      -- Estados de mensajes salientes
      FOR v_status IN SELECT * FROM jsonb_array_elements(COALESCE(v_value->'statuses', '[]')) LOOP
        PERFORM apply_status(v_status);
        v_st := v_st + 1;
      END LOOP;
    END LOOP;
  END LOOP;

  RETURN jsonb_build_object('valid', true, 'event_id', v_event, 'messages_new', v_new,
                            'messages_duplicate', v_dup, 'statuses', v_st, 'wa_ids', to_jsonb(v_wa_ids));
END $$;

-- Números con mensajes pendientes "olvidados" (p.ej. n8n se reinició a mitad):
-- pendientes de más de p_older_than o en 'processing' atascados.
CREATE OR REPLACE FUNCTION chatbot.stalled_wa_ids(p_older_than interval DEFAULT interval '1 minute')
RETURNS TABLE (wa_id text, pending integer)
LANGUAGE sql STABLE SET search_path = chatbot, public AS $$
  SELECT m.wa_id, count(*)::int
    FROM messages m
   WHERE m.direction = 'in' AND m.processing_attempts < 3
     AND ((m.processing_state = 'pending' AND m.received_at < now() - p_older_than)
       OR (m.processing_state = 'processing' AND m.processing_started_at < now() - interval '5 minutes'))
   GROUP BY m.wa_id
$$;

-- Guarda el binario descargado de Meta
CREATE OR REPLACE FUNCTION chatbot.store_media(p_media_id bigint, p_base64 text, p_mime text, p_file_name text)
RETURNS integer
LANGUAGE sql SET search_path = chatbot, public AS $$
  WITH u AS (
    UPDATE media
       SET content = decode(p_base64, 'base64'),
           size_bytes = length(decode(p_base64, 'base64')),
           mime_type = COALESCE(p_mime, mime_type),
           file_name = COALESCE(p_file_name, file_name),
           downloaded_at = now()
     WHERE id = p_media_id
    RETURNING 1)
  SELECT count(*)::int FROM u
$$;

-- Registra un archivo saliente (p.ej. audio de ElevenLabs) y devuelve su id
CREATE OR REPLACE FUNCTION chatbot.store_outbound_media(p_base64 text, p_mime text, p_file_name text, p_meta_media_id text)
RETURNS bigint
LANGUAGE sql SET search_path = chatbot, public AS $$
  INSERT INTO media (direction, meta_media_id, mime_type, file_name, content, size_bytes, downloaded_at)
  VALUES ('out', p_meta_media_id, p_mime, p_file_name, decode(p_base64, 'base64'),
          length(decode(p_base64, 'base64')), now())
  ON CONFLICT (meta_media_id) WHERE meta_media_id IS NOT NULL DO UPDATE SET mime_type = EXCLUDED.mime_type
  RETURNING id
$$;
