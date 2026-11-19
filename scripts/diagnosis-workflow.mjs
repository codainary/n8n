#!/usr/bin/env node
// Genera «FLOW · Diagnóstico» (sub-workflow):
//   paso (chatbot.diagnosis_step) → envía los mensajes (texto / botones / lista)
//   → al terminar: cálculo (fórmula v2 del website) → reporte + botones → Twenty (persona + oportunidad, vía «FLOW · Registrar en Twenty») → Telegram.
// Diagnóstico RÁPIDO (5 preguntas con botones). El cálculo (scripts/diagnosis-calc.js) usa la fórmula v2 de
// automaverso-web (lib/assessment/report.ts) con rangos simplificados y país por indicativo.
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { twentyCall } from './twenty-workflow.mjs';

const PG = { postgres: { id: 'aV6poYyo4OBcJu8E', name: 'Postgres VPS (chatbot)' } };
const WA = { httpHeaderAuth: { id: '30aSXJ9QwShLDa9s', name: 'WhatsApp Graph API (Bearer)' } };
const TG = { telegramApi: { id: 'T2kzKYa0lIBPkI9c', name: 'Telegram Leads (automaversosas_bot)' } };
const STEP = "$('Paso (SQL)').first().json";
const CALC = "$('Calcular diagnóstico').first().json";
export const NEXT_BUTTONS = ['Hablar con un asesor', 'Ver ejemplos'];

const pg = (id, name, pos, query, params, extra = {}) => ({
  id, name, type: 'n8n-nodes-base.postgres', typeVersion: 2.7, position: pos,
  retryOnFail: true, maxTries: 3, waitBetweenTries: 1000, credentials: PG, ...extra,
  parameters: { operation: 'executeQuery', query, options: params ? { queryReplacement: params } : {} },
});
const http = (id, name, pos, parameters, credentials, extra = {}) => ({
  id, name, type: 'n8n-nodes-base.httpRequest', typeVersion: 4.2, position: pos, credentials,
  retryOnFail: true, maxTries: 3, waitBetweenTries: 2000, ...extra, parameters,
});
const graph = (id, name, pos, body, extra = {}) => http(id, name, pos, {
  method: 'POST', url: `=https://graph.facebook.com/v23.0/{{ ${STEP}.phone_number_id }}/messages`,
  authentication: 'genericCredentialType', genericAuthType: 'httpHeaderAuth',
  sendBody: true, specifyBody: 'json', jsonBody: `={{ JSON.stringify(${body}) }}`, options: {},
}, WA, extra);
const set = (id, name, pos, value) => ({
  id, name, type: 'n8n-nodes-base.set', typeVersion: 3.4, position: pos,
  parameters: { assignments: { assignments: [{ id: id + 'a', name: 'response', type: 'string', value }] }, options: {} },
});
const ifNode = (id, name, pos, leftValue) => ({
  id, name, type: 'n8n-nodes-base.if', typeVersion: 2.2, position: pos,
  parameters: { conditions: { options: { caseSensitive: true, leftValue: '', typeValidation: 'loose', version: 2 },
    conditions: [{ id: id + 'c', leftValue, rightValue: '', operator: { type: 'boolean', operation: 'true', singleValue: true } }],
    combinator: 'and' }, options: {} },
});
const connect = (pairs) => {
  const c = {};
  for (const [from, to, out = 0] of pairs) {
    c[from] ??= { main: [] };
    while (c[from].main.length <= out) c[from].main.push([]);
    c[from].main[out].push({ node: to, type: 'main', index: 0 });
  }
  return c;
};

// Un mensaje (item) → cuerpo de la API de WhatsApp. Literal JS con espacios: "}}" cerraría la expresión.
const MESSAGE_BODY = `$json.type === 'text'
  ? { messaging_product: 'whatsapp', recipient_type: 'individual', to: ${STEP}.wa_id, type: 'text', text: { preview_url: false, body: $json.body } }
  : $json.type === 'buttons'
    ? { messaging_product: 'whatsapp', recipient_type: 'individual', to: ${STEP}.wa_id, type: 'interactive', interactive: { type: 'button', body: { text: $json.body }, ...($json.footer ? { footer: { text: $json.footer } } : {}), action: { buttons: $json.buttons.map(b => ({ type: 'reply', reply: { id: b.id, title: b.title } })) } } }
    : { messaging_product: 'whatsapp', recipient_type: 'individual', to: ${STEP}.wa_id, type: 'interactive', interactive: { type: 'list', body: { text: $json.body }, ...($json.footer ? { footer: { text: $json.footer } } : {}), action: { button: $json.button || 'Ver opciones', sections: [ { title: 'Opciones', rows: $json.rows.map(r => ({ id: r.id, title: r.title, ...(r.description ? { description: r.description } : {}) })) } ] } } }`;
const AGENT_TEXT = `$json.body + ($json.buttons ? '\\n[Botones: ' + $json.buttons.map(b => b.title).join(' | ') + ']' : '') + ($json.rows ? '\\n[Lista: ' + $json.rows.map(r => r.title).join(' | ') + ']' : '')`;

// Código del nodo «Calcular diagnóstico» (fórmula, calificación y reporte): scripts/diagnosis-calc.js
const CALCULATE = readFileSync('scripts/diagnosis-calc.js', 'utf8');

const esc = (expr) => `String(${expr} || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')`;
const CRM = "$('Registrar en Twenty').first().json";
const QUAL = `({ encaja: '✅ Encaja', dudoso: '🟡 Dudoso', no_califica: '⛔ No califica' })[${CALC}.qualification]`;
const TELEGRAM_TEXT = `={{ [
  '📊 <b>Nuevo diagnóstico desde WhatsApp</b>',
  '',
  '👤 <b>Nombre:</b> ' + (${esc(`${CALC}.name`)} || 'Sin nombre'),
  '📱 <b>WhatsApp:</b> +' + ${STEP}.wa_id,
  '🏷️ <b>Calificación:</b> ' + ${QUAL} + ' (' + ${CALC}.score + '/8)',
  '⚡ <b>Resultado:</b> ' + ${esc(`${CALC}.headline`)}
].join('\\n') }}`;

const L = (k) => `${CALC}.labels.${k}`;
const TWENTY_INPUTS = {
  source: 'diagnostico',
  wa_id: `={{ ${STEP}.wa_id }}`,
  name: `={{ ${CALC}.name || '' }}`,
  contact_channel: '',
  contact_phone: '',
  note_title: `={{ 'Diagnóstico por WhatsApp · ' + ${CALC}.diagnosisId }}`,
  note: `={{ [ '**Diagnóstico rápido por WhatsApp** (' + ${CALC}.diagnosisId + ')', '', '- Área: ' + ${L('area')}, '- Equipo: ' + ${L('people')} + ' persona(s) × ' + ${L('hours')} + '/semana · ' + ${L('repetition')}, '- Plazo: ' + ${L('timeline')} + ' · País: ' + ${L('country')} + ' (por indicativo)', '- Resultado: ' + ${CALC}.headline, '- Calificación interna: ' + ${CALC}.qualification + ' (' + ${CALC}.score + '/8)', '', '---', '', ${CALC}.report.replace(/\\*/g, '**') ].join('\\n') }}`,
  diag: `={{ ({ dolor: ${L('area')} + ' · ' + ${L('people')} + ' × ' + ${L('hours')} + '/semana · ' + ${L('repetition')}, ahorroUsd: ${CALC}.result.moneyYear ? Math.round((${CALC}.result.moneyYear.min + ${CALC}.result.moneyYear.max) / 2) : null, plazoPais: 'Plazo: ' + ${L('timeline')} + ' · País: ' + ${L('country')} + ' (por indicativo)', qualification: ${CALC}.qualification }) }}`,
};

const wf = {
  name: 'FLOW · Diagnóstico',
  nodes: [
    { id: 'g1', name: 'Entrada', type: 'n8n-nodes-base.executeWorkflowTrigger', typeVersion: 1.3, position: [0, 300],
      parameters: { inputSource: 'workflowInputs', workflowInputs: { values: [
        { name: 'wa_id', type: 'string' }, { name: 'text', type: 'string' }, { name: 'action', type: 'string' }] } } },
    pg('g2', 'Paso (SQL)', [220, 300],
      "SELECT s.*, $1::text AS wa_id, chatbot.config('wa_phone_number_id') AS phone_number_id,\n       chatbot.config('telegram_leads_chat_id') AS telegram_chat_id\n  FROM (SELECT 1) x LEFT JOIN LATERAL chatbot.diagnosis_step($1, $2, $3) s ON true",
      "={{ [ $json.wa_id, $json.text || '', $json.action || 'continue' ] }}"),
    ifNode('g2b', '¿Hay mensajes?', [330, 300], '={{ Array.isArray($json.replies) && $json.replies.length > 0 }}'),
    { id: 'g3', name: 'Un item por mensaje', type: 'n8n-nodes-base.splitOut', typeVersion: 1, position: [440, 300],
      parameters: { fieldToSplitOut: 'replies', options: {} } },
    graph('g4', 'Enviar mensaje', [660, 300], MESSAGE_BODY),
    pg('g5', 'Registrar mensaje (SQL)', [880, 300],
      "SELECT r.* FROM chatbot.register_outbound(jsonb_build_object(\n  'wamid', $1, 'wa_id', $2, 'type', $3, 'text', $4, 'agent_text', $5)) r",
      `={{ [ $json.messages[0].id, ${STEP}.wa_id, $('Un item por mensaje').item.json.type === 'text' ? 'text' : 'interactive', $('Un item por mensaje').item.json.body, (() => { const j = $('Un item por mensaje').item.json; return j.body + (j.buttons ? '\\n[Botones: ' + j.buttons.map(b => b.title).join(' | ') + ']' : '') + (j.rows ? '\\n[Lista: ' + j.rows.map(r => r.title).join(' | ') + ']' : ''); })() ] }}`),
    { id: 'g6', name: 'Una vez', type: 'n8n-nodes-base.limit', typeVersion: 1, position: [1100, 300], parameters: { maxItems: 1, keep: 'lastItems' } },
    ifNode('g7', '¿Diagnóstico completo?', [1320, 300], `={{ ${STEP}.done === true }}`),
    set('g8', 'Respuesta: paso enviado', [1540, 460], 'ENVIADO: el usuario ya recibió la siguiente pregunta del diagnóstico. No agregues texto.'),
    { id: 'g9', name: 'Calcular diagnóstico', type: 'n8n-nodes-base.code', typeVersion: 2, position: [1540, 200], parameters: { jsCode: CALCULATE } },
    // Reporte y botones en UN solo mensaje (dos mensajes seguidos pueden llegar en desorden).
    // El cuerpo de un mensaje interactivo admite 1.024 caracteres; el reporte ronda los 600.
    graph('g10', 'Enviar reporte con botones', [1760, 200],
      `{ messaging_product: 'whatsapp', recipient_type: 'individual', to: ${STEP}.wa_id, type: 'interactive', interactive: { type: 'button', body: { text: ($json.report + '\\n\\n*¿Cómo quieres seguir?*').slice(0, 1024) }, footer: { text: 'Gratis y sin compromiso' }, action: { buttons: [ { type: 'reply', reply: { id: 'asesor', title: '${NEXT_BUTTONS[0]}' } }, { type: 'reply', reply: { id: 'ejemplos', title: '${NEXT_BUTTONS[1]}' } } ] } } }`),
    pg('g12', 'Registrar reporte (SQL)', [1980, 200],
      "SELECT r.message_id AS report_msg FROM chatbot.register_outbound(jsonb_build_object('wamid', $1, 'wa_id', $2, 'type', 'interactive',\n  'text', $3, 'agent_text', $3 || E'\\n\\n¿Cómo quieres seguir? [Botones: " + NEXT_BUTTONS.join(' | ') + "]')) r",
      `={{ [ $json.messages[0].id, ${STEP}.wa_id, ${CALC}.report ] }}`),
    twentyCall('g13', [2200, 200], TWENTY_INPUTS),
    { id: 'g19', name: 'Avisar en Telegram', type: 'n8n-nodes-base.telegram', typeVersion: 1.2, position: [2420, 200],
      credentials: TG, retryOnFail: true, maxTries: 3, waitBetweenTries: 2000, onError: 'continueRegularOutput',
      parameters: {
        resource: 'message', operation: 'sendMessage', chatId: `={{ ${STEP}.telegram_chat_id }}`, text: TELEGRAM_TEXT,
        replyMarkup: 'inlineKeyboard',
        inlineKeyboard: { rows: [
          { row: { buttons: [{ text: '💬 Abrir chat de WhatsApp', additionalFields: { url: `=https://wa.me/{{ ${STEP}.wa_id }}` } }] } },
          { row: { buttons: [{ text: '📇 Ver en el CRM', additionalFields: { url: `={{ ${CRM}.opportunityUrl || 'https://crm.automaverso.com' }}` } }] } },
        ] },
        additionalFields: { parse_mode: 'HTML', disable_web_page_preview: true, appendAttribution: false },
      } },
    pg('g20', 'Guardar resultado (SQL)', [2640, 200],
      "SELECT chatbot.diagnosis_saved($1::int, $2::jsonb, $3, $4::int, $5, $6, NULLIF($7, '')::bigint, $8) AS ok",
      `={{ [ ${STEP}.diagnosis_row_id, JSON.stringify(${CALC}.result), ${CALC}.qualification, ${CALC}.score, ${CALC}.diagnosisId, ${CRM}.leadId || '', String($json.result?.message_id || $json.message_id || ''), ($json.result?.message_id || $json.message_id) ? '' : JSON.stringify($json.error || $json).slice(0, 500) ] }}`),
    set('g21', 'Respuesta: diagnóstico entregado', [2860, 200], 'ENVIADO: el usuario ya recibió su diagnóstico y los botones para seguir. No agregues texto.'),
    set('g22', 'Respuesta: sin diagnóstico', [660, 480], 'SIN_DIAGNOSTICO'),
    { id: 'note', name: 'Nota', type: 'n8n-nodes-base.stickyNote', typeVersion: 1, position: [-40, -100],
      parameters: { width: 960, height: 320, content: '## FLOW · Diagnóstico\nEntradas: `wa_id`, `text`, `action` (`start` | `continue`).\n1. `chatbot.diagnosis_step`: diagnóstico RÁPIDO, 5 preguntas con 3 botones cada una (área, personas, horas, repetición, plazo). *cancelar* lo detiene; se puede retomar dentro de 24 h.\n2. Al terminar, **Calcular diagnóstico** (`scripts/diagnosis-calc.js`) aplica la fórmula v2 del website con rangos simplificados; el país sale del indicativo y el costo por hora es la referencia de ese país. Calificación interna simplificada (0-8).\n3. Envía el reporte + botones *Hablar con un asesor* / *Ver ejemplos* → **Twenty** (`FLOW · Registrar en Twenty`: persona por teléfono + oportunidad Comercial con los campos del diagnóstico y una nota) → aviso en Telegram con la calificación y enlace al CRM.' } },
  ],
  connections: connect([
    ['Entrada', 'Paso (SQL)'], ['Paso (SQL)', '¿Diagnóstico completo?'],
    ['¿Diagnóstico completo?', 'Calcular diagnóstico', 0], ['¿Diagnóstico completo?', '¿Hay mensajes?', 1], ['¿Hay mensajes?', 'Un item por mensaje', 0], ['¿Hay mensajes?', 'Respuesta: sin diagnóstico', 1], ['Un item por mensaje', 'Enviar mensaje'],
    ['Enviar mensaje', 'Registrar mensaje (SQL)'], ['Registrar mensaje (SQL)', 'Una vez'], ['Una vez', 'Respuesta: paso enviado'],
    ['Calcular diagnóstico', 'Enviar reporte con botones'], ['Enviar reporte con botones', 'Registrar reporte (SQL)'],
    ['Registrar reporte (SQL)', 'Registrar en Twenty'], ['Registrar en Twenty', 'Avisar en Telegram'], ['Avisar en Telegram', 'Guardar resultado (SQL)'],
    ['Guardar resultado (SQL)', 'Respuesta: diagnóstico entregado'],
  ]),
  settings: { executionOrder: 'v1', saveDataErrorExecution: 'all', saveDataSuccessExecution: 'all', timezone: 'America/Bogota' },
};

const path = 'workflows/FLOW · Diagnóstico.json';
if (existsSync(path)) wf.id = JSON.parse(readFileSync(path, 'utf8')).id;
writeFileSync(path, JSON.stringify(wf, null, 2) + '\n');
console.log('escrito', path, wf.id || '(nuevo)');
