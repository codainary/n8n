#!/usr/bin/env node
// Genera «FLOW · Diagnóstico» (sub-workflow):
//   paso (chatbot.diagnosis_step) → envía los mensajes (texto / botones / lista)
//   → al terminar: cálculo (fórmula v2 del website) → reporte + botones → Sheet (Leads + Diagnósticos) → Telegram.
// Diagnóstico RÁPIDO (5 preguntas con botones). El cálculo (scripts/diagnosis-calc.js) usa la fórmula v2 de
// automaverso-web (lib/assessment/report.ts) con rangos simplificados y país por indicativo.
import { readFileSync, writeFileSync, existsSync } from 'node:fs';

const PG = { postgres: { id: 'aV6poYyo4OBcJu8E', name: 'Postgres VPS (chatbot)' } };
const WA = { httpHeaderAuth: { id: '30aSXJ9QwShLDa9s', name: 'WhatsApp Graph API (Bearer)' } };
const GS = { googleApi: { id: '7rT6HnkbOiymsTAt', name: 'Google Sheets Leads (cuenta de servicio n8n-kb)' } };
const TG = { telegramApi: { id: 'T2kzKYa0lIBPkI9c', name: 'Telegram Leads (automaversosas_bot)' } };
const STEP = "$('Paso (SQL)').first().json";
const CALC = "$('Calcular diagnóstico').first().json";
const SHEETS = 'https://sheets.googleapis.com/v4/spreadsheets';
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

const PREPARE_ROWS = String.raw`// Why Code: ubicar a la persona en «Leads» (por teléfono), combinar su fila sin pisar lo del website
// y armar la fila de «Diagnósticos»; todo por NOMBRE de columna.
const step = $('Paso (SQL)').first().json;
const c = $('Calcular diagnóstico').first().json;
const [leadsRange, diagRange] = $('Leer Sheet (Leads + Diagnósticos)').first().json.valueRanges;
const values = leadsRange.values || [];
const header = (values[0] || []).map(h => String(h).trim());
const dHeader = ((diagRange.values || [])[0] || []).map(h => String(h).trim());
const col = (h) => header.indexOf(h);
for (const h of ['Lead ID', 'Etapa', 'WhatsApp / teléfono', 'Diagnóstico ID']) if (col(h) < 0) throw new Error('Falta la columna «' + h + '» en Leads');
if (dHeader.indexOf('Diagnóstico ID') < 0) throw new Error('Falta la hoja Diagnósticos o su columna «Diagnóstico ID»');

const last10 = (v) => String(v || '').replace(/\D/g, '').slice(-10);
const key = last10(step.wa_id);
let rowIndex = -1;
// 1) por el Lead ID que ya conocemos de este WhatsApp; 2) por teléfono
if (step.known_lead_id) rowIndex = values.findIndex((r, i) => i > 0 && String(r[col('Lead ID')] || '').trim() === step.known_lead_id);
if (rowIndex < 1) for (let i = values.length - 1; i >= 1; i--) if (last10(values[i][col('WhatsApp / teléfono')]) === key) { rowIndex = i; break; }
const isNew = rowIndex < 0;
const row = isNew ? [] : [...values[rowIndex]];
while (row.length < header.length) row.push('');
const get = (h) => (col(h) >= 0 ? String(row[col(h)] ?? '').trim() : '');
const put = (h, v) => { if (col(h) >= 0) row[col(h)] = v; };
const pretty = (d) => /^57\d{10}$/.test(d) ? '+57 ' + d.slice(2, 5) + ' ' + d.slice(5, 8) + ' ' + d.slice(8) : '+' + d;

const leadId = isNew ? 'WA-' + c.today + '-D' + String(step.diagnosis_row_id).padStart(4, '0') : get('Lead ID');
if (isNew) { put('Lead ID', leadId); put('Canal de entrada', 'WhatsApp'); put('Creado', c.now); put('WhatsApp / teléfono', pretty(step.wa_id)); }
put('Etapa', 'Diagnosticado');
if (!get('Nombre o empresa') && c.name) put('Nombre o empresa', c.name);
if (!get('Correo') && c.email) put('Correo', c.email);
put('Diagnóstico ID', c.diagnosisId);
put('Actualizado', c.now);

const r = c.result;
const dVals = {
  'Diagnóstico ID': c.diagnosisId, 'Lead ID': leadId, 'Fecha': c.now, 'Canal': 'WhatsApp', 'Idioma': 'ES',
  'País': c.labels.country + ' (por indicativo)', 'Plazo': c.labels.timeline, 'Áreas': c.labels.area,
  'Horas manuales/semana': r.weeklyManualHours ?? '',
  'Ahorro anual estimado (US$)': r.moneyYear ? r.moneyYear.min + '–' + r.moneyYear.max : '',
  'Calificación': c.qualification + ' (' + c.score + '/8)',
  'Reporte': c.headline + ' · ' + c.labels.people + ' persona(s), ' + c.labels.hours + '/semana c/u, ' + c.labels.repetition.toLowerCase(),
};
const dRow = dHeader.map(h => dVals[h] ?? '');
const lastCol = (n) => String.fromCharCode(64 + n);
const sheetRow = isNew ? null : rowIndex + 1;
return [{ json: {
  isNew, leadId, row, dRow,
  leadRange: isNew ? 'Leads!A1:' + lastCol(header.length) + '1' : 'Leads!A' + sheetRow + ':' + lastCol(header.length) + sheetRow,
  diagRange: 'Diagnósticos!A1:' + lastCol(dHeader.length) + '1',
} }];`;

const esc = (expr) => `String(${expr} || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')`;
const ROWS = "$('Preparar filas').first().json";
const QUAL = `({ encaja: '✅ Encaja', dudoso: '🟡 Dudoso', no_califica: '⛔ No califica' })[${CALC}.qualification]`;
const TELEGRAM_TEXT = `={{ [
  '📊 <b>Nuevo diagnóstico desde WhatsApp</b>',
  '',
  '👤 <b>Nombre:</b> ' + (${esc(`${CALC}.name`)} || 'Sin nombre'),
  '📱 <b>WhatsApp:</b> +' + ${STEP}.wa_id,
  '🏷️ <b>Calificación:</b> ' + ${QUAL} + ' (' + ${CALC}.score + '/8)',
  '⚡ <b>Resultado:</b> ' + ${esc(`${CALC}.headline`)}
].join('\\n') }}`;

const wf = {
  name: 'FLOW · Diagnóstico',
  nodes: [
    { id: 'g1', name: 'Entrada', type: 'n8n-nodes-base.executeWorkflowTrigger', typeVersion: 1.3, position: [0, 300],
      parameters: { inputSource: 'workflowInputs', workflowInputs: { values: [
        { name: 'wa_id', type: 'string' }, { name: 'text', type: 'string' }, { name: 'action', type: 'string' }] } } },
    pg('g2', 'Paso (SQL)', [220, 300],
      "SELECT s.*, $1::text AS wa_id, chatbot.config('wa_phone_number_id') AS phone_number_id,\n       chatbot.config('leads_sheet_id') AS sheet_id, chatbot.config('telegram_leads_chat_id') AS telegram_chat_id,\n       chatbot.known_lead_id($1) AS known_lead_id\n  FROM (SELECT 1) x LEFT JOIN LATERAL chatbot.diagnosis_step($1, $2, $3) s ON true",
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
    http('g13', 'Leer Sheet (Leads + Diagnósticos)', [2420, 200], {
      url: `=${SHEETS}/{{ ${STEP}.sheet_id }}/values:batchGet?ranges=Leads!A1:Z&ranges={{ encodeURIComponent('Diagnósticos!A1:Z1') }}`,
      authentication: 'predefinedCredentialType', nodeCredentialType: 'googleApi', options: {},
    }, GS),
    { id: 'g14', name: 'Preparar filas', type: 'n8n-nodes-base.code', typeVersion: 2, position: [2640, 200], parameters: { jsCode: PREPARE_ROWS } },
    ifNode('g15', '¿Lead nuevo?', [2860, 200], '={{ $json.isNew }}'),
    http('g16', 'Agregar lead (Sheets)', [3080, 100], {
      method: 'POST', url: `=${SHEETS}/{{ ${STEP}.sheet_id }}/values/{{ encodeURIComponent($json.leadRange) }}:append?valueInputOption=RAW&insertDataOption=OVERWRITE`,
      authentication: 'predefinedCredentialType', nodeCredentialType: 'googleApi', sendBody: true, specifyBody: 'json',
      jsonBody: '={{ JSON.stringify({ values: [ $json.row ] }) }}', options: {},
    }, GS, { onError: 'continueRegularOutput' }),
    http('g17', 'Actualizar lead (Sheets)', [3080, 300], {
      method: 'PUT', url: `=${SHEETS}/{{ ${STEP}.sheet_id }}/values/{{ encodeURIComponent($json.leadRange) }}?valueInputOption=RAW`,
      authentication: 'predefinedCredentialType', nodeCredentialType: 'googleApi', sendBody: true, specifyBody: 'json',
      jsonBody: '={{ JSON.stringify({ values: [ $json.row ] }) }}', options: {},
    }, GS, { onError: 'continueRegularOutput' }),
    http('g18', 'Agregar diagnóstico (Sheets)', [3300, 200], {
      method: 'POST', url: `=${SHEETS}/{{ ${STEP}.sheet_id }}/values/{{ encodeURIComponent(${ROWS}.diagRange) }}:append?valueInputOption=RAW&insertDataOption=OVERWRITE`,
      authentication: 'predefinedCredentialType', nodeCredentialType: 'googleApi', sendBody: true, specifyBody: 'json',
      jsonBody: `={{ JSON.stringify({ values: [ ${ROWS}.dRow ] }) }}`, options: {},
    }, GS, { onError: 'continueRegularOutput' }),
    { id: 'g19', name: 'Avisar en Telegram', type: 'n8n-nodes-base.telegram', typeVersion: 1.2, position: [3520, 200],
      credentials: TG, retryOnFail: true, maxTries: 3, waitBetweenTries: 2000, onError: 'continueRegularOutput',
      parameters: {
        resource: 'message', operation: 'sendMessage', chatId: `={{ ${STEP}.telegram_chat_id }}`, text: TELEGRAM_TEXT,
        replyMarkup: 'inlineKeyboard',
        inlineKeyboard: { rows: [
          { row: { buttons: [{ text: '💬 Abrir chat de WhatsApp', additionalFields: { url: `=https://wa.me/{{ ${STEP}.wa_id }}` } }] } },
          { row: { buttons: [{ text: '📊 Ver en el Sheet', additionalFields: { url: `=https://docs.google.com/spreadsheets/d/{{ ${STEP}.sheet_id }}/edit` } }] } },
        ] },
        additionalFields: { parse_mode: 'HTML', disable_web_page_preview: true, appendAttribution: false },
      } },
    pg('g20', 'Guardar resultado (SQL)', [3740, 200],
      "SELECT chatbot.diagnosis_saved($1::int, $2::jsonb, $3, $4::int, $5, $6, NULLIF($7, '')::bigint, $8) AS ok",
      `={{ [ ${STEP}.diagnosis_row_id, JSON.stringify(${CALC}.result), ${CALC}.qualification, ${CALC}.score, ${CALC}.diagnosisId, ${ROWS}.leadId, String($json.result?.message_id || $json.message_id || ''), ($json.result?.message_id || $json.message_id) ? '' : JSON.stringify($json.error || $json).slice(0, 500) ] }}`),
    set('g21', 'Respuesta: diagnóstico entregado', [3960, 200], 'ENVIADO: el usuario ya recibió su diagnóstico y los botones para seguir. No agregues texto.'),
    set('g22', 'Respuesta: sin diagnóstico', [660, 480], 'SIN_DIAGNOSTICO'),
    { id: 'note', name: 'Nota', type: 'n8n-nodes-base.stickyNote', typeVersion: 1, position: [-40, -100],
      parameters: { width: 960, height: 320, content: '## FLOW · Diagnóstico\nEntradas: `wa_id`, `text`, `action` (`start` | `continue`).\n1. `chatbot.diagnosis_step`: diagnóstico RÁPIDO, 5 preguntas con 3 botones cada una (área, personas, horas, repetición, plazo). *cancelar* lo detiene; se puede retomar dentro de 24 h.\n2. Al terminar, **Calcular diagnóstico** (`scripts/diagnosis-calc.js`) aplica la fórmula v2 del website con rangos simplificados; el país sale del indicativo y el costo por hora es la referencia de ese país. Calificación interna simplificada (0-8).\n3. Envía el reporte + botones *Hablar con un asesor* / *Ver ejemplos* → Sheet: **Leads** (crea o actualiza; Etapa *Diagnosticado*, Diagnóstico ID) y **Diagnósticos** (nueva fila, Canal WhatsApp) → aviso en Telegram con la calificación.' } },
  ],
  connections: connect([
    ['Entrada', 'Paso (SQL)'], ['Paso (SQL)', '¿Diagnóstico completo?'],
    ['¿Diagnóstico completo?', 'Calcular diagnóstico', 0], ['¿Diagnóstico completo?', '¿Hay mensajes?', 1], ['¿Hay mensajes?', 'Un item por mensaje', 0], ['¿Hay mensajes?', 'Respuesta: sin diagnóstico', 1], ['Un item por mensaje', 'Enviar mensaje'],
    ['Enviar mensaje', 'Registrar mensaje (SQL)'], ['Registrar mensaje (SQL)', 'Una vez'], ['Una vez', 'Respuesta: paso enviado'],
    ['Calcular diagnóstico', 'Enviar reporte con botones'], ['Enviar reporte con botones', 'Registrar reporte (SQL)'],
    ['Registrar reporte (SQL)', 'Leer Sheet (Leads + Diagnósticos)'], ['Leer Sheet (Leads + Diagnósticos)', 'Preparar filas'],
    ['Preparar filas', '¿Lead nuevo?'], ['¿Lead nuevo?', 'Agregar lead (Sheets)', 0], ['¿Lead nuevo?', 'Actualizar lead (Sheets)', 1],
    ['Agregar lead (Sheets)', 'Agregar diagnóstico (Sheets)'], ['Actualizar lead (Sheets)', 'Agregar diagnóstico (Sheets)'],
    ['Agregar diagnóstico (Sheets)', 'Avisar en Telegram'], ['Avisar en Telegram', 'Guardar resultado (SQL)'],
    ['Guardar resultado (SQL)', 'Respuesta: diagnóstico entregado'],
  ]),
  settings: { executionOrder: 'v1', saveDataErrorExecution: 'all', saveDataSuccessExecution: 'all', timezone: 'America/Bogota' },
};

const path = 'workflows/FLOW · Diagnóstico.json';
if (existsSync(path)) wf.id = JSON.parse(readFileSync(path, 'utf8')).id;
writeFileSync(path, JSON.stringify(wf, null, 2) + '\n');
console.log('escrito', path, wf.id || '(nuevo)');
