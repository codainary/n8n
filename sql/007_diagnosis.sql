-- ==========================================================================
-- Diagnóstico RÁPIDO de automatización por WhatsApp: 5 preguntas con botones. Usa la fórmula v2 del
-- website (automaverso-web: lib/assessment/report.ts) con rangos simplificados.
-- Motor de preguntas por número: cada paso devuelve los mensajes a enviar (texto, botones o lista).
-- El cálculo (fórmula v2) y la calificación se hacen en «FLOW · Diagnóstico» al terminar.
-- Idempotente.
-- ==========================================================================

CREATE TABLE IF NOT EXISTS chatbot.diagnoses (
  id                  serial PRIMARY KEY,
  wa_id               text NOT NULL,
  status              text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'done', 'cancelled', 'expired')),
  step                text NOT NULL,
  sub                 text,                    -- 'more' (¿agregar otra?) | 'other' (escribir la tarea)
  attempts            integer NOT NULL DEFAULT 0,
  answers             jsonb NOT NULL DEFAULT '{}',
  result              jsonb,                   -- reporte calculado (fórmula v2)
  qualification       text,
  score               integer,
  diagnosis_id        text,                    -- DIAG-WA-…
  lead_id             text,
  telegram_message_id bigint,
  notify_error        text,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  completed_at        timestamptz
);
CREATE UNIQUE INDEX IF NOT EXISTS diagnoses_one_active ON chatbot.diagnoses (wa_id) WHERE status = 'active';

-- --------------------------------------------------------------------------
-- Catálogo de preguntas: diagnóstico RÁPIDO por WhatsApp (5 preguntas, todas con 2-3 botones,
-- títulos ≤ 20 caracteres). El país se deduce del indicativo del WhatsApp y el costo por hora es la
-- referencia del website para ese país (ver «Calcular diagnóstico» en FLOW · Diagnóstico).
-- kind: single ; ui: buttons
-- --------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION chatbot.diag_questions() RETURNS jsonb
LANGUAGE sql IMMUTABLE AS $$
SELECT $j$[
 {"key":"area","kind":"single","ui":"buttons","body":"¿En qué parte de tu negocio se te va *más tiempo*?","options":[
   {"code":"comunicaciones","title":"Atención y ventas"},
   {"code":"operaciones","title":"Operaciones/finanzas"},
   {"code":"contenido","title":"Marketing/contenido"}]},
 {"key":"people","kind":"single","ui":"buttons","body":"¿Cuántas *personas* se encargan de esas tareas?","options":[
   {"code":"1","title":"Solo yo"},{"code":"2-5","title":"2 a 5"},{"code":"5+","title":"Más de 5"}]},
 {"key":"hours","kind":"single","ui":"buttons","body":"Más o menos, ¿cuántas *horas a la semana* les dedica cada una?","options":[
   {"code":"lt5","title":"Menos de 5 h"},{"code":"5-10","title":"5 a 10 h"},{"code":"10+","title":"Más de 10 h"}]},
 {"key":"repetition","kind":"single","ui":"buttons","body":"¿Esas tareas se hacen *casi siempre igual*?\n\n_Mientras más se repiten, más se pueden automatizar._","options":[
   {"code":"always","title":"Siempre igual"},{"code":"mostly","title":"Casi siempre"},{"code":"varies","title":"Cambia bastante"}]},
 {"key":"timeline","kind":"single","ui":"buttons","body":"Última: ¿para cuándo te gustaría *resolverlo*?","options":[
   {"code":"this-month","title":"Este mes"},{"code":"1-3-months","title":"En 1 a 3 meses"},{"code":"exploring","title":"Solo explorando"}]}
]$j$::jsonb
$$;

-- Tareas de ejemplo por área (website: lib/content/es.ts → processExamples)
CREATE OR REPLACE FUNCTION chatbot.diag_process_examples(p_area text) RETURNS text[]
LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE p_area
    WHEN 'a-medida'       THEN ARRAY['Pasar datos entre sistemas', 'Aprobaciones internas', 'Reportes a la medida']
    WHEN 'contenido'      THEN ARRAY['Escribir posts para redes', 'Armar el newsletter', 'Fichas de producto']
    WHEN 'comunicaciones' THEN ARRAY['Responder mensajes de WhatsApp', 'Registrar leads en el CRM', 'Seguimiento de cotizaciones']
    WHEN 'operaciones'    THEN ARRAY['Digitar facturas de proveedores', 'Conciliar pagos', 'Reportes manuales']
    WHEN 'diseno'         THEN ARRAY['Piezas para redes', 'Editar videos cortos', 'Adaptar diseños a formatos']
    WHEN 'web'            THEN ARRAY['Actualizar contenido del sitio', 'Revisar SEO y velocidad', 'Atender formularios del sitio']
    ELSE ARRAY[]::text[] END
$$;

-- Preguntas que aplican a esta persona (el nombre solo si no lo conocemos)
CREATE OR REPLACE FUNCTION chatbot.diag_keys(p_answers jsonb) RETURNS text[]
LANGUAGE sql STABLE AS $$
  SELECT array_agg(q->>'key' ORDER BY ord)
    FROM jsonb_array_elements(chatbot.diag_questions()) WITH ORDINALITY AS t(q, ord)
   WHERE NOT (q->>'key' = 'name' AND COALESCE(p_answers->>'known_name', '') <> '')
$$;

-- Opciones de una pregunta ya resueltas para esta persona (proceso según área, costo en pesos si es Colombia)
CREATE OR REPLACE FUNCTION chatbot.diag_options(p_key text, p_answers jsonb) RETURNS jsonb
LANGUAGE plpgsql STABLE AS $$
DECLARE
  q jsonb;
  v_ex text[];
BEGIN
  SELECT x INTO q FROM jsonb_array_elements(chatbot.diag_questions()) x WHERE x->>'key' = p_key;
  IF p_key = 'process' THEN
    v_ex := chatbot.diag_process_examples(p_answers->'areas'->>0);
    RETURN COALESCE((SELECT jsonb_agg(jsonb_build_object('code', e, 'title', left(e, 24), 'desc', CASE WHEN length(e) > 24 THEN e END) ORDER BY i)
                       FROM unnest(v_ex) WITH ORDINALITY AS u(e, i)), '[]'::jsonb)
           || '[{"code":"other","title":"Otra tarea","desc":"La escribo yo"},{"code":"skip","title":"Omitir"}]'::jsonb;
  ELSIF p_key = 'hourlyCost' AND p_answers->>'country' = 'co' THEN
    RETURN (SELECT jsonb_agg(o || jsonb_build_object('title', COALESCE(o->>'title_co', o->>'title'))) FROM jsonb_array_elements(q->'options') o);
  END IF;
  RETURN COALESCE(q->'options', '[]'::jsonb);
END $$;

-- Mensaje(s) para preguntar `p_key` (p_prefix: aviso antes de la pregunta, p. ej. "Elige una opción")
CREATE OR REPLACE FUNCTION chatbot.diag_render(p_key text, p_answers jsonb, p_prefix text DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql STABLE AS $$
DECLARE
  q       jsonb;
  v_opts  jsonb;
  v_keys  text[] := chatbot.diag_keys(p_answers);
  v_body  text;
  v_foot  text;
  v_taken jsonb := COALESCE(p_answers->p_key, '[]'::jsonb);
BEGIN
  SELECT x INTO q FROM jsonb_array_elements(chatbot.diag_questions()) x WHERE x->>'key' = p_key;
  v_body := COALESCE(p_prefix || E'\n\n', '') || (q->>'body');
  v_foot := 'Pregunta ' || array_position(v_keys, p_key) || ' de ' || array_length(v_keys, 1);
  v_opts := chatbot.diag_options(p_key, p_answers);
  -- En selección múltiple no se repiten las ya elegidas
  IF q->>'kind' = 'multi' AND jsonb_typeof(v_taken) = 'array' THEN
    v_opts := (SELECT COALESCE(jsonb_agg(o), '[]'::jsonb) FROM jsonb_array_elements(v_opts) o WHERE NOT v_taken ? (o->>'code'));
    IF jsonb_array_length(v_taken) > 0 THEN
      v_opts := (SELECT COALESCE(jsonb_agg(o), '[]'::jsonb) FROM jsonb_array_elements(v_opts) o WHERE NOT COALESCE((o->>'terminal')::boolean, false));
    END IF;
  END IF;

  IF q->>'kind' = 'text' THEN
    RETURN jsonb_build_array(jsonb_build_object('type', 'text', 'body', v_body || E'\n\n_' || v_foot || '_'));
  ELSIF q->>'ui' = 'buttons' THEN
    RETURN jsonb_build_array(jsonb_build_object('type', 'buttons', 'body', v_body, 'footer', v_foot,
      'buttons', (SELECT jsonb_agg(jsonb_build_object('id', o->>'code', 'title', o->>'title')) FROM jsonb_array_elements(v_opts) o)));
  END IF;
  RETURN jsonb_build_array(jsonb_build_object('type', 'list', 'body', v_body, 'footer', v_foot, 'button', 'Ver opciones',
    'rows', (SELECT jsonb_agg(jsonb_strip_nulls(jsonb_build_object('id', o->>'code', 'title', o->>'title', 'description', o->>'desc')))
               FROM jsonb_array_elements(v_opts) o)));
END $$;

-- Busca la opción que corresponde a lo que respondió el usuario (título del botón/lista o texto parecido)
CREATE OR REPLACE FUNCTION chatbot.diag_match(p_options jsonb, p_text text) RETURNS jsonb
LANGUAGE sql STABLE AS $$
  WITH t AS (SELECT trim(regexp_replace(chatbot.norm(p_text), '[^a-z0-9$+ ]', ' ', 'g')) AS v)
  SELECT o FROM jsonb_array_elements(p_options) WITH ORDINALITY AS x(o, i), t
   WHERE t.v <> '' AND (
         trim(regexp_replace(chatbot.norm(o->>'title'), '[^a-z0-9$+ ]', ' ', 'g')) = t.v
      OR trim(regexp_replace(chatbot.norm(o->>'title_co'), '[^a-z0-9$+ ]', ' ', 'g')) = t.v
      OR t.v = i::text)
   ORDER BY i LIMIT 1
$$;

CREATE OR REPLACE FUNCTION chatbot.active_diagnosis_step(p_wa_id text) RETURNS text
LANGUAGE sql STABLE SET search_path = chatbot, public AS $$
  SELECT step FROM diagnoses
   WHERE wa_id = p_wa_id AND status = 'active' AND updated_at > now() - interval '24 hours'
$$;

-- p_action: 'start' | 'continue'. Devuelve los mensajes a enviar (replies) y, al terminar, done = true con las respuestas.
CREATE OR REPLACE FUNCTION chatbot.diagnosis_step(p_wa_id text, p_text text, p_action text)
RETURNS TABLE (diagnosis_row_id integer, done boolean, replies jsonb, answers jsonb)
LANGUAGE plpgsql SET search_path = chatbot, public AS $$
#variable_conflict use_column
DECLARE
  d       diagnoses%ROWTYPE;
  q       jsonb;
  v_text  text := trim(regexp_replace(COALESCE(p_text, ''), '^\[Nota de voz\]\s*', ''));
  v_norm  text;
  v_opt   jsonb;
  v_ans   jsonb;
  v_keys  text[];
  v_next  text;
  v_out   jsonb := '[]'::jsonb;
  v_done  boolean := false;
  v_name  text;
  v_taken jsonb;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext('diagnosis:' || p_wa_id));
  v_norm := regexp_replace(trim(regexp_replace(norm(v_text), '[^a-z0-9@._+ -]', ' ', 'g')), '\s+', ' ', 'g');

  UPDATE diagnoses SET status = 'expired', updated_at = now()
   WHERE wa_id = p_wa_id AND status = 'active' AND updated_at <= now() - interval '24 hours';

  -- Pedir de nuevo el diagnóstico (botón o texto) con uno en curso lo reinicia, no cuenta como respuesta.
  -- También se reinicia si el diagnóstico activo es de un formato anterior (su paso ya no existe).
  IF p_action = 'start'
     OR v_norm IN ('diagnostico gratis', 'diagnostico', 'hacer el diagnostico', 'quiero el diagnostico')
     OR EXISTS (SELECT 1 FROM diagnoses x WHERE x.wa_id = p_wa_id AND x.status = 'active'
                   AND NOT EXISTS (SELECT 1 FROM jsonb_array_elements(diag_questions()) q WHERE q->>'key' = x.step)) THEN
    UPDATE diagnoses SET status = 'cancelled', updated_at = now() WHERE wa_id = p_wa_id AND status = 'active';
    -- Nombre ya conocido (solicitud de asesor o diagnóstico anterior)
    SELECT n INTO v_name FROM (
      SELECT name AS n, updated_at FROM handoffs WHERE wa_id = p_wa_id AND name IS NOT NULL
      UNION ALL SELECT answers->>'name', updated_at FROM diagnoses WHERE wa_id = p_wa_id AND answers->>'name' IS NOT NULL) x
     ORDER BY updated_at DESC LIMIT 1;
    v_ans := CASE WHEN v_name IS NOT NULL THEN jsonb_build_object('known_name', v_name, 'name', v_name) ELSE '{}'::jsonb END;
    INSERT INTO diagnoses (wa_id, step, answers) VALUES (p_wa_id, 'area', v_ans) RETURNING * INTO d;
    -- Introducción y primera pregunta en UN solo mensaje: dos mensajes seguidos pueden llegar en desorden.
    v_out := diag_render('area', v_ans,
      E'¡Vamos! Son solo *' || array_length(diag_keys(v_ans), 1) || E' preguntas* con botones. Al final te muestro *cuánto tiempo y dinero* podrías ahorrar automatizando.');
    RETURN QUERY SELECT d.id, false, v_out, d.answers;
    RETURN;
  END IF;

  SELECT * INTO d FROM diagnoses WHERE wa_id = p_wa_id AND status = 'active' FOR UPDATE;
  IF NOT FOUND THEN RETURN; END IF;

  IF v_norm IN ('cancelar', 'cancela', 'salir', 'detener', 'ya no', 'no gracias') THEN
    UPDATE diagnoses SET status = 'cancelled', updated_at = now() WHERE id = d.id;
    RETURN QUERY SELECT d.id, false, jsonb_build_array(jsonb_build_object('type', 'text',
      'body', E'Listo, dejé el diagnóstico aquí.\n\nSi quieres retomarlo, escribe *diagnóstico gratis*.')), d.answers;
    RETURN;
  END IF;

  SELECT x INTO q FROM jsonb_array_elements(diag_questions()) x WHERE x->>'key' = d.step;
  v_ans := d.answers;
  v_next := NULL;   -- se llena cuando la pregunta actual queda respondida

  IF q->>'kind' = 'multi' THEN
    v_taken := COALESCE(v_ans->d.step, '[]'::jsonb);
    IF d.sub = 'more' AND v_norm ~ '^(continuar|seguir|listo|no|ninguna mas|siguiente)\y' THEN
      v_next := 'next';
    ELSIF d.sub = 'more' AND v_norm ~ '^(agregar|otra|si|anadir)\y' AND v_norm !~ 'herramienta' THEN
      UPDATE diagnoses SET sub = NULL, attempts = 0, updated_at = now() WHERE id = d.id;
      v_out := diag_render(d.step, v_ans);
    ELSE
      v_opt := diag_match(diag_options(d.step, v_ans), v_text);
      IF v_opt IS NULL THEN
        UPDATE diagnoses SET attempts = attempts + 1, updated_at = now() WHERE id = d.id;
        v_out := CASE WHEN d.sub = 'more'
          THEN jsonb_build_array(jsonb_build_object('type', 'buttons', 'body', '¿Agregas otra opción o continuamos?',
                 'buttons', '[{"id":"add","title":"Agregar otra"},{"id":"continue","title":"Continuar"}]'::jsonb))
          ELSE diag_render(d.step, v_ans, 'Elige una opción de la lista 👇') END;
      ELSIF COALESCE((v_opt->>'terminal')::boolean, false) THEN
        v_ans := jsonb_set(v_ans, ARRAY[d.step], '[]'::jsonb);
        v_next := 'next';
      ELSE
        IF NOT v_taken ? (v_opt->>'code') THEN v_taken := v_taken || jsonb_build_array(v_opt->>'code'); END IF;
        v_ans := jsonb_set(v_ans, ARRAY[d.step], v_taken);
        -- ¿quedan opciones por elegir?
        IF (SELECT count(*) FROM jsonb_array_elements(diag_options(d.step, v_ans)) o
             WHERE NOT v_taken ? (o->>'code') AND NOT COALESCE((o->>'terminal')::boolean, false)) = 0 THEN
          v_next := 'next';
        ELSE
          UPDATE diagnoses SET answers = v_ans, sub = 'more', attempts = 0, updated_at = now() WHERE id = d.id;
          v_out := jsonb_build_array(jsonb_build_object('type', 'buttons',
            'body', 'Elegiste: *' || (SELECT string_agg(o->>'title', ', ') FROM jsonb_array_elements(diag_options(d.step, v_ans)) o WHERE v_taken ? (o->>'code')) || E'*\n\n¿Agregas otra opción?',
            'buttons', '[{"id":"add","title":"Agregar otra"},{"id":"continue","title":"Continuar"}]'::jsonb));
        END IF;
      END IF;
    END IF;

  ELSIF q->>'kind' = 'process' THEN
    IF d.sub = 'other' THEN
      IF length(v_text) BETWEEN 3 AND 150 THEN
        v_ans := jsonb_set(v_ans, '{process}', to_jsonb(v_text)); v_next := 'next';
      ELSE
        UPDATE diagnoses SET attempts = attempts + 1, updated_at = now() WHERE id = d.id;
        v_out := jsonb_build_array(jsonb_build_object('type', 'text', 'body', E'Escríbela en pocas palabras.\n\n_Ej.: armar cotizaciones por correo_'));
      END IF;
    ELSE
      v_opt := diag_match(diag_options('process', v_ans), v_text);
      IF v_opt->>'code' = 'other' THEN
        UPDATE diagnoses SET sub = 'other', attempts = 0, updated_at = now() WHERE id = d.id;
        v_out := jsonb_build_array(jsonb_build_object('type', 'text', 'body', E'¿Cuál tarea? Escríbela en pocas palabras.\n\n_Ej.: armar cotizaciones por correo_'));
      ELSIF v_opt->>'code' = 'skip' THEN
        v_next := 'next';
      ELSIF v_opt IS NOT NULL THEN
        v_ans := jsonb_set(v_ans, '{process}', to_jsonb(v_opt->>'code')); v_next := 'next';
      ELSIF length(v_text) BETWEEN 3 AND 150 AND v_text !~ '^\[' THEN   -- escribió la tarea directamente
        v_ans := jsonb_set(v_ans, '{process}', to_jsonb(v_text)); v_next := 'next';
      ELSE
        UPDATE diagnoses SET attempts = attempts + 1, updated_at = now() WHERE id = d.id;
        v_out := diag_render('process', v_ans, 'Elige una opción de la lista 👇');
      END IF;
    END IF;

  ELSIF q->>'kind' = 'single' THEN
    v_opt := diag_match(diag_options(d.step, v_ans), v_text);
    IF v_opt IS NULL THEN
      UPDATE diagnoses SET attempts = attempts + 1, updated_at = now() WHERE id = d.id;
      v_out := diag_render(d.step, v_ans, CASE WHEN q->>'ui' = 'buttons' THEN 'Elige una de las opciones 👇' ELSE 'Elige una opción de la lista 👇' END);
    ELSE
      v_ans := jsonb_set(v_ans, ARRAY[d.step], to_jsonb(v_opt->>'code')); v_next := 'next';
    END IF;

  ELSIF q->>'kind' = 'text' THEN   -- nombre
    v_name := trim(both ' .,!;:' FROM regexp_replace(v_text, '^\s*(hola[\s,!.]*)?((me llamo|mi nombre es|yo soy|soy|es)\s+)?', '', 'i'));
    IF length(v_name) BETWEEN 2 AND 60 AND v_name !~ '[?@/]|https?|\[' AND array_length(regexp_split_to_array(v_name, '\s+'), 1) <= 6 THEN
      IF v_name = lower(v_name) THEN v_name := initcap(v_name); END IF;
      v_ans := jsonb_set(v_ans, '{name}', to_jsonb(v_name)); v_next := 'next';
    ELSE
      UPDATE diagnoses SET attempts = attempts + 1, updated_at = now() WHERE id = d.id;
      v_out := diag_render('name', v_ans, '¿Me confirmas solo tu nombre o el de tu empresa?');
    END IF;

  ELSIF q->>'kind' = 'email' THEN
    IF v_norm ~ '^(omitir|no|saltar|ninguno|no tengo)' THEN
      v_next := 'next';
    ELSIF lower(v_text) ~ '^[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}$' THEN
      v_ans := jsonb_set(v_ans, '{email}', to_jsonb(lower(v_text))); v_next := 'next';
    ELSE
      UPDATE diagnoses SET attempts = attempts + 1, updated_at = now() WHERE id = d.id;
      v_out := diag_render('email', v_ans, 'Ese correo no parece válido. Escríbelo de nuevo o toca *Omitir*.');
    END IF;
  END IF;

  IF v_next IS NOT NULL THEN
    v_keys := diag_keys(v_ans);
    v_next := v_keys[array_position(v_keys, d.step) + 1];
    IF v_next IS NULL THEN
      UPDATE diagnoses SET answers = v_ans, step = 'done', sub = NULL, status = 'done', completed_at = now(), updated_at = now() WHERE id = d.id;
      v_done := true;
      v_out := '[]'::jsonb;   -- el reporte sale directo (sin mensaje intermedio que pueda llegar en desorden)
    ELSE
      UPDATE diagnoses SET answers = v_ans, step = v_next, sub = NULL, attempts = 0, updated_at = now() WHERE id = d.id;
      v_out := diag_render(v_next, v_ans);
    END IF;
  ELSIF (SELECT attempts FROM diagnoses WHERE id = d.id) >= 4 THEN
    UPDATE diagnoses SET status = 'cancelled', updated_at = now() WHERE id = d.id;
    v_out := jsonb_build_array(jsonb_build_object('type', 'text',
      'body', E'Dejemos el diagnóstico aquí por ahora.\n\nCuando quieras retomarlo, escribe *diagnóstico gratis*.'));
  END IF;

  RETURN QUERY SELECT d.id, v_done, v_out, v_ans;
END $$;

-- Resultado: reporte calculado, IDs y aviso por Telegram
CREATE OR REPLACE FUNCTION chatbot.diagnosis_saved(p_id integer, p_result jsonb, p_qualification text, p_score integer,
                                                   p_diagnosis_id text, p_lead_id text, p_telegram_message_id bigint, p_error text)
RETURNS boolean
LANGUAGE sql SET search_path = chatbot, public AS $$
  UPDATE diagnoses
     SET result = p_result, qualification = p_qualification, score = p_score, diagnosis_id = NULLIF(p_diagnosis_id, ''),
         lead_id = NULLIF(p_lead_id, ''), telegram_message_id = p_telegram_message_id, notify_error = NULLIF(p_error, ''),
         updated_at = now()
   WHERE id = p_id
  RETURNING true
$$;

-- Lead ID que ya tiene este WhatsApp en el Sheet (de una solicitud de asesor o un diagnóstico anterior).
-- Se busca primero por este ID: el teléfono del Sheet puede ser otro (p. ej. "llámame a otro número").
CREATE OR REPLACE FUNCTION chatbot.known_lead_id(p_wa_id text) RETURNS text
LANGUAGE sql STABLE SET search_path = chatbot, public AS $$
  SELECT lead_id FROM (
    SELECT lead_id, updated_at FROM handoffs WHERE wa_id = p_wa_id AND lead_id IS NOT NULL
    UNION ALL
    SELECT lead_id, updated_at FROM diagnoses WHERE wa_id = p_wa_id AND lead_id IS NOT NULL) x
   ORDER BY updated_at DESC LIMIT 1
$$;
