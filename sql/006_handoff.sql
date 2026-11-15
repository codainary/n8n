-- ==========================================================================
-- Solicitud de contacto con un asesor ("Hablar con un asesor").
-- Máquina de estados por número de WhatsApp:
--   ask_name → ask_channel → (confirm_phone → ask_phone) → done
-- Cada paso devuelve la respuesta a enviar (texto o botones). Al terminar, FLOW · Contacto con asesor
-- guarda el lead en el Sheet y avisa por Telegram.
-- Idempotente.
-- ==========================================================================

CREATE TABLE IF NOT EXISTS chatbot.handoffs (
  id                  serial PRIMARY KEY,
  wa_id               text NOT NULL,
  status              text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'done', 'cancelled', 'expired')),
  step                text NOT NULL DEFAULT 'ask_name',
  attempts            integer NOT NULL DEFAULT 0,       -- respuestas no válidas en el paso actual
  name                text,
  channel             text CHECK (channel IN ('chat', 'whatsapp_call', 'phone_call')),
  phone               text,                             -- dígitos con indicativo, sin '+'
  lead_id             text,
  sheet_row           integer,
  diagnosis_id        text,
  summary             text,
  telegram_message_id bigint,
  notified_at         timestamptz,
  notify_error        text,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  completed_at        timestamptz
);
CREATE UNIQUE INDEX IF NOT EXISTS handoffs_one_active ON chatbot.handoffs (wa_id) WHERE status = 'active';

-- +57 315 342 2554 (Colombia) o +<dígitos>
CREATE OR REPLACE FUNCTION chatbot.pretty_phone(p_digits text) RETURNS text
LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE WHEN p_digits ~ '^57\d{10}$'
              THEN '+57 ' || substr(p_digits, 3, 3) || ' ' || substr(p_digits, 6, 3) || ' ' || substr(p_digits, 9, 4)
              ELSE '+' || p_digits END
$$;

CREATE OR REPLACE FUNCTION chatbot.channel_label(p_channel text) RETURNS text
LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE p_channel WHEN 'chat' THEN 'Chat de WhatsApp' WHEN 'whatsapp_call' THEN 'Llamada por WhatsApp'
                        WHEN 'phone_call' THEN 'Llamada al celular' END
$$;

-- Solicitud activa (no abandonada) de un número
CREATE OR REPLACE FUNCTION chatbot.active_handoff_step(p_wa_id text) RETURNS text
LANGUAGE sql STABLE SET search_path = chatbot, public AS $$
  SELECT step FROM handoffs
   WHERE wa_id = p_wa_id AND status = 'active' AND updated_at > now() - interval '2 hours'
$$;

-- p_action: 'start' (botón o pedido del agente) | 'continue' (respuesta del usuario a un paso)
CREATE OR REPLACE FUNCTION chatbot.handoff_step(p_wa_id text, p_text text, p_action text)
RETURNS TABLE (handoff_id integer, done boolean, reply jsonb, name text, channel text, channel_label text,
               phone text, phone_pretty text)
LANGUAGE plpgsql SET search_path = chatbot, public AS $$
#variable_conflict use_column
DECLARE
  h       handoffs%ROWTYPE;
  v_text  text := trim(regexp_replace(COALESCE(p_text, ''), '^\[Nota de voz\]\s*', ''));
  v_norm  text;
  v_name  text;
  v_dig   text;
  v_reply jsonb;
  v_done  boolean := false;
  CANCEL_HINT constant text := E'\n\n_Escribe *cancelar* si prefieres no seguir._';
  BTN_CHANNEL constant jsonb := '[{"id":"chat","title":"Escríbanme por aquí"},{"id":"whatsapp_call","title":"Llamada por WhatsApp"},{"id":"phone_call","title":"Llamada a mi celular"}]';
  BTN_PHONE constant jsonb := '[{"id":"same_phone","title":"Sí, a este número"},{"id":"other_phone","title":"Otro número"}]';
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext('handoff:' || p_wa_id));
  v_norm := trim(regexp_replace(norm(v_text), '[^a-z0-9 ]', ' ', 'g'));
  v_norm := regexp_replace(v_norm, '\s+', ' ', 'g');

  UPDATE handoffs SET status = 'expired', updated_at = now()
   WHERE wa_id = p_wa_id AND status = 'active' AND updated_at <= now() - interval '2 hours';

  IF p_action = 'start' THEN
    UPDATE handoffs SET status = 'cancelled', updated_at = now() WHERE wa_id = p_wa_id AND status = 'active';
    -- Si ya conocemos el nombre (diagnóstico o solicitud anterior), no se vuelve a pedir
    SELECT n INTO v_name FROM (
      SELECT name AS n, updated_at FROM handoffs WHERE wa_id = p_wa_id AND name IS NOT NULL
      UNION ALL SELECT answers->>'name', updated_at FROM diagnoses WHERE wa_id = p_wa_id AND answers->>'name' IS NOT NULL) x
     ORDER BY updated_at DESC LIMIT 1;
    IF v_name IS NOT NULL THEN
      INSERT INTO handoffs (wa_id, name, step) VALUES (p_wa_id, v_name, 'ask_channel') RETURNING * INTO h;
      v_reply := jsonb_build_object('type', 'buttons',
        'body', E'¡Con gusto! Un asesor de *Automaverso* se pondrá en contacto contigo.\n\n¿Cómo prefieres que te contactemos?', 'buttons', BTN_CHANNEL);
    ELSE
      INSERT INTO handoffs (wa_id) VALUES (p_wa_id) RETURNING * INTO h;
      v_reply := jsonb_build_object('type', 'text',
        'body', E'¡Con gusto! Un asesor de *Automaverso* se pondrá en contacto contigo.\n\nPara empezar, ¿cuál es tu *nombre* o el de tu empresa?');
    END IF;
  ELSE
    SELECT * INTO h FROM handoffs WHERE wa_id = p_wa_id AND status = 'active' FOR UPDATE;
    IF NOT FOUND THEN RETURN; END IF;

    IF v_norm IN ('cancelar', 'cancela', 'cancelalo', 'salir', 'no gracias', 'ya no', 'olvidalo') THEN
      UPDATE handoffs SET status = 'cancelled', updated_at = now() WHERE id = h.id;
      v_reply := jsonb_build_object('type', 'text', 'body', E'Listo, cancelé la solicitud.\n\n¿Te ayudo con algo más?');

    ELSIF h.step = 'ask_name' THEN
      v_name := regexp_replace(v_text, '^\s*(hola[\s,!.]*)?((me llamo|mi nombre es|yo soy|soy|es)\s+)?', '', 'i');
      v_name := trim(both ' .,!;:' FROM v_name);
      IF length(v_name) BETWEEN 2 AND 60 AND v_name !~ '[?@/]|https?|\[' AND array_length(regexp_split_to_array(v_name, '\s+'), 1) <= 6 THEN
        IF v_name = lower(v_name) THEN v_name := initcap(v_name); END IF;
        UPDATE handoffs SET name = v_name, step = 'ask_channel', attempts = 0, updated_at = now() WHERE id = h.id;
        v_reply := jsonb_build_object('type', 'buttons', 'body', '¡Gracias! ¿Cómo prefieres que te contactemos?', 'buttons', BTN_CHANNEL);
      ELSE
        UPDATE handoffs SET attempts = attempts + 1, updated_at = now() WHERE id = h.id RETURNING * INTO h;
        v_reply := jsonb_build_object('type', 'text', 'body', '¿Me confirmas tu *nombre* o el de tu empresa?' || CANCEL_HINT);
      END IF;

    ELSIF h.step = 'ask_channel' THEN
      h.channel := CASE
        WHEN v_norm ~ 'escrib|chat|por aqui|mensaje' THEN 'chat'
        WHEN v_norm ~ 'whatsapp' AND v_norm ~ 'llam' THEN 'whatsapp_call'
        WHEN v_norm ~ 'celular|telefono|movil|llam' THEN 'phone_call' END;
      IF h.channel IN ('chat', 'whatsapp_call') THEN
        UPDATE handoffs SET channel = h.channel, phone = p_wa_id, status = 'done', step = 'done', completed_at = now(), updated_at = now()
         WHERE id = h.id;
        v_done := true;
      ELSIF h.channel = 'phone_call' THEN
        UPDATE handoffs SET channel = 'phone_call', step = 'confirm_phone', attempts = 0, updated_at = now() WHERE id = h.id;
        v_reply := jsonb_build_object('type', 'buttons', 'body', E'¿Te llamamos a este número?\n\n*' || pretty_phone(p_wa_id) || '*', 'buttons', BTN_PHONE);
      ELSE
        UPDATE handoffs SET attempts = attempts + 1, updated_at = now() WHERE id = h.id;
        v_reply := jsonb_build_object('type', 'buttons', 'body', 'Elige cómo prefieres que te contactemos:' || CANCEL_HINT, 'buttons', BTN_CHANNEL);
      END IF;

    ELSIF h.step = 'confirm_phone' THEN
      IF v_norm ~ '^(si|claro|correcto|ese|este|dale|ok)\y' OR v_norm ~ 'este numero' THEN
        UPDATE handoffs SET phone = p_wa_id, status = 'done', step = 'done', completed_at = now(), updated_at = now() WHERE id = h.id;
        v_done := true;
      ELSIF v_norm ~ 'otro|^no\y|diferente' THEN
        UPDATE handoffs SET step = 'ask_phone', attempts = 0, updated_at = now() WHERE id = h.id;
        v_reply := jsonb_build_object('type', 'text', 'body', E'Escríbeme el número con su indicativo.\n\n_Ejemplo: +57 300 123 4567_');
      ELSE
        v_dig := regexp_replace(v_text, '\D', '', 'g');
        IF length(v_dig) BETWEEN 10 AND 15 THEN   -- escribió directamente otro número
          IF v_dig ~ '^3\d{9}$' THEN v_dig := '57' || v_dig; END IF;
          UPDATE handoffs SET phone = v_dig, status = 'done', step = 'done', completed_at = now(), updated_at = now() WHERE id = h.id;
          v_done := true;
        ELSE
          UPDATE handoffs SET attempts = attempts + 1, updated_at = now() WHERE id = h.id;
          v_reply := jsonb_build_object('type', 'buttons', 'body', E'¿Te llamamos a este número?\n\n*' || pretty_phone(p_wa_id) || '*', 'buttons', BTN_PHONE);
        END IF;
      END IF;

    ELSIF h.step = 'ask_phone' THEN
      v_dig := regexp_replace(v_text, '\D', '', 'g');
      IF v_dig ~ '^3\d{9}$' THEN v_dig := '57' || v_dig; END IF;
      IF length(v_dig) BETWEEN 10 AND 15 THEN
        UPDATE handoffs SET phone = v_dig, status = 'done', step = 'done', completed_at = now(), updated_at = now() WHERE id = h.id;
        v_done := true;
      ELSE
        UPDATE handoffs SET attempts = attempts + 1, updated_at = now() WHERE id = h.id;
        v_reply := jsonb_build_object('type', 'text', 'body', E'Ese número no parece válido. Escríbelo con su indicativo.\n\n_Ejemplo: +57 300 123 4567_' || CANCEL_HINT);
      END IF;
    END IF;

    -- Tras 3 respuestas no válidas seguidas se cancela para no dejar al usuario atrapado
    IF NOT v_done AND (SELECT attempts FROM handoffs WHERE id = h.id) >= 3 THEN
      UPDATE handoffs SET status = 'cancelled', updated_at = now() WHERE id = h.id;
      v_reply := jsonb_build_object('type', 'text',
        'body', E'No te preocupes, dejemos esto por ahora.\n\nSi quieres, escríbenos a *hello@automaverso.com* o pide de nuevo *hablar con un asesor*.');
    END IF;
  END IF;

  SELECT * INTO h FROM handoffs WHERE id = h.id;
  IF v_done THEN
    v_reply := jsonb_build_object('type', 'text', 'body', CASE h.channel
      WHEN 'chat'          THEN E'¡Listo! ✅\n\nUn asesor te escribirá *por este chat* muy pronto.'
      WHEN 'whatsapp_call' THEN E'¡Listo! ✅\n\nUn asesor te llamará *por WhatsApp* muy pronto.'
      ELSE E'¡Listo! ✅\n\nUn asesor te llamará al *' || pretty_phone(h.phone) || '* muy pronto.' END);
  END IF;

  RETURN QUERY SELECT h.id, v_done, v_reply, h.name, h.channel, channel_label(h.channel), h.phone, pretty_phone(h.phone);
END $$;

-- Resultado del registro en el Sheet y del aviso por Telegram
CREATE OR REPLACE FUNCTION chatbot.handoff_notified(p_id integer, p_lead_id text, p_sheet_row integer, p_diagnosis_id text,
                                                    p_summary text, p_telegram_message_id bigint, p_error text)
RETURNS boolean
LANGUAGE sql SET search_path = chatbot, public AS $$
  UPDATE handoffs
     SET lead_id = NULLIF(p_lead_id, ''), sheet_row = p_sheet_row, diagnosis_id = NULLIF(p_diagnosis_id, ''),
         summary = p_summary, telegram_message_id = p_telegram_message_id,
         notified_at = CASE WHEN p_telegram_message_id IS NOT NULL THEN now() END,
         notify_error = NULLIF(p_error, ''), updated_at = now()
   WHERE id = p_id
  RETURNING true
$$;
