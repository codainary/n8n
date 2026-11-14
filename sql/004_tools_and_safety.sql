-- ==========================================================================
-- Fase 2: trazabilidad de herramientas del agente y de los filtros de seguridad.
-- Idempotente.
-- ==========================================================================

-- Cada bloqueo de un guardrail (entrada o salida del agente)
CREATE TABLE IF NOT EXISTS chatbot.moderation_events (
  id         bigserial PRIMARY KEY,
  wa_id      text,
  batch_id   uuid,
  stage      text NOT NULL CHECK (stage IN ('input', 'output')),
  text       text,                 -- texto evaluado (recortado)
  result     jsonb,                -- salida completa del nodo Guardrails
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS moderation_events_wa_idx ON chatbot.moderation_events (wa_id, created_at DESC);

-- Cada consulta del agente a la base de conocimiento
CREATE TABLE IF NOT EXISTS kb.query_log (
  id          bigserial PRIMARY KEY,
  query       text NOT NULL,
  category    text,
  top_score   real,
  n_results   integer NOT NULL,
  answered    boolean NOT NULL,    -- false = SIN_INFORMACION (pregunta que la base no cubre)
  sources     jsonb,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS kb_query_log_created_idx ON kb.query_log (created_at DESC);

-- Preguntas que la base no supo responder (insumo para mejorar el FAQ)
CREATE OR REPLACE VIEW kb.v_unanswered AS
SELECT query, category, top_score, created_at
  FROM kb.query_log
 WHERE NOT answered
 ORDER BY created_at DESC;
