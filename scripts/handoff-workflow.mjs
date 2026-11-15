#!/usr/bin/env node
// Genera «FLOW · Contacto con asesor» (sub-workflow):
//   paso de la conversación (chatbot.handoff_step) → respuesta al usuario (texto o botones)
//   → si terminó: resumen (OpenAI) → Sheet «Automaverso · Leads» (crear/actualizar) → aviso en Telegram.
// Conserva el id si el JSON ya existe.
import { readFileSync, writeFileSync, existsSync } from 'node:fs';

const PG = { postgres: { id: 'aV6poYyo4OBcJu8E', name: 'Postgres VPS (chatbot)' } };
const WA = { httpHeaderAuth: { id: '30aSXJ9QwShLDa9s', name: 'WhatsApp Graph API (Bearer)' } };
const OAI = { openAiApi: { id: 'sevrRORNVNDEXyvj', name: 'OpenAI (chatbot)' } };
const GS = { googleApi: { id: '7rT6HnkbOiymsTAt', name: 'Google Sheets Leads (cuenta de servicio n8n-kb)' } };
const TG = { telegramApi: { id: 'T2kzKYa0lIBPkI9c', name: 'Telegram Leads (automaversosas_bot)' } };
const STEP = "$('Paso (SQL)').first().json";
const SHEETS = 'https://sheets.googleapis.com/v4/spreadsheets';

const pg = (id, name, pos, query, params, extra = {}) => ({
  id, name, type: 'n8n-nodes-base.postgres', typeVersion: 2.7, position: pos,
  retryOnFail: true, maxTries: 3, waitBetweenTries: 1000, credentials: PG, ...extra,
  parameters: { operation: 'executeQuery', query, options: params ? { queryReplacement: params } : {} },
});
const http = (id, name, pos, parameters, credentials, extra = {}) => ({
  id, name, type: 'n8n-nodes-base.httpRequest', typeVersion: 4.2, position: pos, credentials,
  retryOnFail: true, maxTries: 3, waitBetweenTries: 2000, ...extra, parameters,
});
const graph = (id, name, pos, body) => http(id, name, pos, {
  method: 'POST', url: `=https://graph.facebook.com/v23.0/{{ ${STEP}.phone_number_id }}/messages`,
  authentication: 'genericCredentialType', genericAuthType: 'httpHeaderAuth',
  sendBody: true, specifyBody: 'json', jsonBody: `={{ JSON.stringify(${body}) }}`, options: {},
}, WA);
const set = (id, name, pos, value) => ({
  id, name, type: 'n8n-nodes-base.set', typeVersion: 3.4, position: pos,
  parameters: { assignments: { assignments: [{ id: id + 'a', name: 'response', type: 'string', value }] }, options: {} },
});
const ifNode = (id, name, pos, leftValue, operator, rightValue = '') => ({
  id, name, type: 'n8n-nodes-base.if', typeVersion: 2.2, position: pos,
  parameters: { conditions: { options: { caseSensitive: true, leftValue: '', typeValidation: 'loose', version: 2 },
    conditions: [{ id: id + 'c', leftValue, rightValue, operator }], combinator: 'and' }, options: {} },
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

// Botones de WhatsApp como literal JS con espacios (un "}}" cerraría la expresión de n8n)
const BUTTONS_EXPR = `${STEP}.reply.buttons.map(b => ({ type: 'reply', reply: { id: b.id, title: b.title } }))`;

const PREPARE_ROW = String.raw`// Why Code: ubicar a la persona en el Sheet (por teléfono, por nombre de columna) y combinar
// su fila existente con los datos nuevos sin pisar lo que llenó el website.
const step = $('Paso (SQL)').first().json;
const values = $('Leer Leads (Sheets)').first().json.values || [];
const header = (values[0] || []).map(h => String(h).trim());
const col = (name) => header.indexOf(name);
const required = ['Lead ID', 'Etapa', 'Nombre o empresa', 'WhatsApp / teléfono', 'Medio de contacto', 'Diagnóstico ID',
  'Resumen conversación (WhatsApp)', 'Canal de entrada', 'Creado', 'Actualizado'];
const missing = required.filter(h => col(h) < 0);
if (missing.length) throw new Error('Faltan columnas en la hoja Leads: ' + missing.join(', '));

const last10 = (v) => String(v || '').replace(/\D/g, '').slice(-10);
const keys = new Set([last10(step.wa_id), last10(step.phone)].filter(k => k.length === 10));
let rowIndex = -1;  // índice en values (0 = encabezado)
// 1) por el Lead ID que ya conocemos de este WhatsApp; 2) por teléfono
if (step.known_lead_id) rowIndex = values.findIndex((r, i) => i > 0 && String(r[col('Lead ID')] || '').trim() === step.known_lead_id);
for (let i = values.length - 1; i >= 1 && rowIndex < 1; i--) {
  if (keys.has(last10(values[i][col('WhatsApp / teléfono')]))) { rowIndex = i; break; }
}
const now = DateTime.now().setZone('America/Bogota').toFormat('yyyy-MM-dd HH:mm');
const row = rowIndex > 0 ? [...values[rowIndex]] : [];
while (row.length < header.length) row.push('');
const get = (h) => String(row[col(h)] ?? '').trim();
const put = (h, v) => { if (col(h) >= 0) row[col(h)] = v; };

const isNew = rowIndex < 0;
const leadId = isNew ? 'WA-' + DateTime.now().setZone('America/Bogota').toFormat('yyyyMMdd') + '-' + String(step.handoff_id).padStart(4, '0') : get('Lead ID');
if (isNew) { put('Lead ID', leadId); put('Canal de entrada', 'WhatsApp'); put('Creado', now); }
if (!get('Etapa')) put('Etapa', 'Contacto solicitado');
if (!get('Nombre o empresa') && step.name) put('Nombre o empresa', step.name);
put('WhatsApp / teléfono', step.phone_pretty);
put('Medio de contacto', step.channel_label);
put('Resumen conversación (WhatsApp)', $('Resumir conversación (OpenAI)').first().json.choices?.[0]?.message?.content?.trim() || '');
put('Actualizado', now);

const sheetRow = isNew ? null : rowIndex + 1;  // número de fila en la hoja
const lastCol = String.fromCharCode(64 + header.length);
return [{ json: {
  isNew, leadId, sheetRow, row,
  range: isNew ? 'Leads!A1:' + lastCol + '1' : 'Leads!A' + sheetRow + ':' + lastCol + sheetRow,
  diagnosisId: get('Diagnóstico ID'),
  name: get('Nombre o empresa') || step.name || '',
  summary: get('Resumen conversación (WhatsApp)'),
} }];`;

const esc = (expr) => `String(${expr} || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')`;
const L = "$('Preparar fila del lead').first().json";
const TELEGRAM_TEXT = `={{ [
  '🔔 <b>Nuevo lead desde WhatsApp</b>',
  '',
  '👤 <b>Nombre:</b> ' + ${esc(`${L}.name`)},
  '📞 <b>Prefiere:</b> ' + ${STEP}.channel_label,
  '📱 <b>Teléfono:</b> ' + ${STEP}.phone_pretty,
  '🧾 <b>Diagnóstico:</b> ' + (${L}.diagnosisId ? '✅ Sí (' + ${esc(`${L}.diagnosisId`)} + ')' : '❌ No'),
  '🆔 <b>Lead:</b> ' + ${L}.leadId + (${L}.isNew ? ' (nuevo)' : ' (existente)'),
  '',
  '📝 <b>Resumen</b>',
  ${esc(`${L}.summary`)},
  '',
  '☎️ Llamar: +' + ${STEP}.phone
].join('\\n') }}`;

const SUMMARY_PROMPT = 'Resume en español, en 2 o 3 frases cortas, la conversación de WhatsApp entre un posible cliente y el asistente de Automaverso (automatización con IA). Incluye qué necesita o le interesa al cliente, su negocio o sector si lo mencionó, y si vio ejemplos. No inventes datos ni incluyas saludos. Si no hay información útil, di que solo pidió hablar con un asesor.';

const wf = {
  name: 'FLOW · Contacto con asesor',
  nodes: [
    { id: 'h1', name: 'Entrada', type: 'n8n-nodes-base.executeWorkflowTrigger', typeVersion: 1.3, position: [0, 300],
      parameters: { inputSource: 'workflowInputs', workflowInputs: { values: [
        { name: 'wa_id', type: 'string' }, { name: 'text', type: 'string' }, { name: 'action', type: 'string' }] } } },
    pg('h2', 'Paso (SQL)', [220, 300],
      "SELECT s.*, $1::text AS wa_id, chatbot.config('wa_phone_number_id') AS phone_number_id,\n       chatbot.config('leads_sheet_id') AS sheet_id, chatbot.config('telegram_leads_chat_id') AS telegram_chat_id,\n       chatbot.known_lead_id($1) AS known_lead_id\n  FROM (SELECT 1) x LEFT JOIN LATERAL chatbot.handoff_step($1, $2, $3) s ON true",
      "={{ [ $json.wa_id, $json.text || '', $json.action || 'continue' ] }}"),
    { id: 'h3', name: 'Tipo de respuesta', type: 'n8n-nodes-base.switch', typeVersion: 3.2, position: [440, 300],
      parameters: { rules: { values: ['text', 'buttons'].map((t) => ({ renameOutput: true, outputKey: t,
        conditions: { options: { caseSensitive: true, leftValue: '', typeValidation: 'loose', version: 2 },
          conditions: [{ id: 'r' + t, leftValue: '={{ $json.reply?.type }}', rightValue: t, operator: { type: 'string', operation: 'equals' } }],
          combinator: 'and' } })) },
      options: { fallbackOutput: 'extra', renameFallbackOutput: 'sin solicitud' } } },
    graph('h4', 'Enviar texto', [680, 180],
      `{ messaging_product: 'whatsapp', recipient_type: 'individual', to: ${STEP}.wa_id, type: 'text', text: { preview_url: false, body: ${STEP}.reply.body } }`),
    graph('h5', 'Enviar botones', [680, 360],
      `{ messaging_product: 'whatsapp', recipient_type: 'individual', to: ${STEP}.wa_id, type: 'interactive', interactive: { type: 'button', body: { text: ${STEP}.reply.body }, action: { buttons: ${BUTTONS_EXPR} } } }`),
    pg('h6', 'Registrar respuesta (SQL)', [900, 260],
      "SELECT r.* FROM chatbot.register_outbound(jsonb_build_object(\n  'wamid', $1, 'wa_id', $2, 'type', $3, 'text', $4, 'agent_text', $5)) r",
      `={{ [ $json.messages[0].id, ${STEP}.wa_id, ${STEP}.reply.type === 'buttons' ? 'interactive' : 'text', ${STEP}.reply.body, ${STEP}.reply.body + (${STEP}.reply.type === 'buttons' ? '\\n[Botones: ' + ${STEP}.reply.buttons.map(b => b.title).join(' | ') + ']' : '') ] }}`),
    ifNode('h7', '¿Solicitud completa?', [1120, 260], `={{ ${STEP}.done === true }}`, { type: 'boolean', operation: 'true', singleValue: true }),
    set('h8', 'Respuesta: paso enviado', [1340, 420], 'ENVIADO: el usuario ya recibió el siguiente paso de la solicitud de asesor. No agregues texto.'),
    set('h9', 'Respuesta: sin solicitud', [680, 560], 'SIN_SOLICITUD'),
    pg('h10', 'Conversación (SQL)', [1340, 160],
      "SELECT string_agg(CASE role WHEN 'user' THEN 'Cliente: ' ELSE 'Asistente: ' END || content, E'\\n' ORDER BY at) AS transcript\n  FROM chatbot.agent_context($1, 40)",
      `={{ [ ${STEP}.wa_id ] }}`),
    http('h11', 'Resumir conversación (OpenAI)', [1560, 160], {
      method: 'POST', url: 'https://api.openai.com/v1/chat/completions',
      authentication: 'predefinedCredentialType', nodeCredentialType: 'openAiApi', sendBody: true, specifyBody: 'json',
      jsonBody: `={{ JSON.stringify({ model: 'gpt-4.1-mini', temperature: 0.2, max_tokens: 200, messages: [ { role: 'system', content: ${JSON.stringify(SUMMARY_PROMPT)} }, { role: 'user', content: $json.transcript || '' } ] }) }}`,
      options: {},
    }, OAI, { onError: 'continueRegularOutput' }),
    http('h12', 'Leer Leads (Sheets)', [1780, 160], {
      url: `=${SHEETS}/{{ ${STEP}.sheet_id }}/values/Leads!A1:Z?valueRenderOption=FORMATTED_VALUE`,
      authentication: 'predefinedCredentialType', nodeCredentialType: 'googleApi', options: {},
    }, GS),
    { id: 'h13', name: 'Preparar fila del lead', type: 'n8n-nodes-base.code', typeVersion: 2, position: [2000, 160],
      parameters: { jsCode: PREPARE_ROW } },
    ifNode('h14', '¿Lead nuevo?', [2220, 160], '={{ $json.isNew }}', { type: 'boolean', operation: 'true', singleValue: true }),
    http('h15', 'Agregar lead (Sheets)', [2440, 60], {
      method: 'POST', url: `=${SHEETS}/{{ ${STEP}.sheet_id }}/values/{{ encodeURIComponent($json.range) }}:append?valueInputOption=RAW&insertDataOption=OVERWRITE`,
      authentication: 'predefinedCredentialType', nodeCredentialType: 'googleApi', sendBody: true, specifyBody: 'json',
      jsonBody: '={{ JSON.stringify({ values: [ $json.row ] }) }}', options: {},
    }, GS, { onError: 'continueRegularOutput' }),
    http('h16', 'Actualizar lead (Sheets)', [2440, 260], {
      method: 'PUT', url: `=${SHEETS}/{{ ${STEP}.sheet_id }}/values/{{ encodeURIComponent($json.range) }}?valueInputOption=RAW`,
      authentication: 'predefinedCredentialType', nodeCredentialType: 'googleApi', sendBody: true, specifyBody: 'json',
      jsonBody: '={{ JSON.stringify({ values: [ $json.row ] }) }}', options: {},
    }, GS, { onError: 'continueRegularOutput' }),
    { id: 'h17', name: 'Avisar en Telegram', type: 'n8n-nodes-base.telegram', typeVersion: 1.2, position: [2660, 160],
      credentials: TG, retryOnFail: true, maxTries: 3, waitBetweenTries: 2000, onError: 'continueRegularOutput',
      parameters: {
        resource: 'message', operation: 'sendMessage', chatId: `={{ ${STEP}.telegram_chat_id }}`, text: TELEGRAM_TEXT,
        replyMarkup: 'inlineKeyboard',
        inlineKeyboard: { rows: [
          { row: { buttons: [{ text: '💬 Abrir chat de WhatsApp', additionalFields: { url: `=https://wa.me/{{ ${STEP}.wa_id }}` } }] } },
          { row: { buttons: [{ text: '📊 Ver en el Sheet', additionalFields: { url: `=https://docs.google.com/spreadsheets/d/{{ ${STEP}.sheet_id }}/edit#gid=1664279207` } }] } },
        ] },
        additionalFields: { parse_mode: 'HTML', disable_web_page_preview: true, appendAttribution: false },
      } },
    pg('h18', 'Registrar aviso (SQL)', [2880, 160],
      'SELECT chatbot.handoff_notified($1::int, $2, NULLIF($3, \'\')::int, $4, $5, NULLIF($6, \'\')::bigint, $7) AS ok',
      `={{ [ ${STEP}.handoff_id, ${L}.leadId, ${L}.isNew ? (String(($('Agregar lead (Sheets)').first().json.updates || {}).updatedRange || '').match(/![A-Z]+(\\d+)/) || [])[1] || '' : String(${L}.sheetRow), ${L}.diagnosisId, ${L}.summary, String($json.result?.message_id || $json.message_id || ''), ($json.result?.message_id || $json.message_id) ? '' : JSON.stringify($json.error || $json).slice(0, 500) ] }}`),
    set('h19', 'Respuesta: contacto registrado', [3100, 160], 'ENVIADO: la solicitud de asesor quedó registrada y el usuario ya recibió la confirmación. No agregues texto.'),
    { id: 'note', name: 'Nota', type: 'n8n-nodes-base.stickyNote', typeVersion: 1, position: [-40, -80],
      parameters: { width: 900, height: 300, content: '## FLOW · Contacto con asesor\nEntradas: `wa_id`, `text` (respuesta del usuario), `action` (`start` | `continue`).\n1. `chatbot.handoff_step` avanza la solicitud: nombre → medio de contacto (chat / llamada WhatsApp / llamada al celular) → confirmar u obtener el número. Devuelve el texto o los botones a enviar. *cancelar* la detiene; vence a las 2 h.\n2. Al completarse: resumen de la conversación (OpenAI) → hoja **Leads** del Sheet «Automaverso · Leads» (busca a la persona por teléfono; si existe solo actualiza contacto, resumen y fecha; si no, crea `WA-…` con Etapa *Contacto solicitado*) → aviso al grupo de Telegram con enlace al chat y si hizo diagnóstico.\n3. Resultado en `chatbot.handoffs`. Devuelve `{ response }`.' } },
  ],
  connections: connect([
    ['Entrada', 'Paso (SQL)'], ['Paso (SQL)', 'Tipo de respuesta'],
    ['Tipo de respuesta', 'Enviar texto', 0], ['Tipo de respuesta', 'Enviar botones', 1], ['Tipo de respuesta', 'Respuesta: sin solicitud', 2],
    ['Enviar texto', 'Registrar respuesta (SQL)'], ['Enviar botones', 'Registrar respuesta (SQL)'],
    ['Registrar respuesta (SQL)', '¿Solicitud completa?'],
    ['¿Solicitud completa?', 'Conversación (SQL)', 0], ['¿Solicitud completa?', 'Respuesta: paso enviado', 1],
    ['Conversación (SQL)', 'Resumir conversación (OpenAI)'], ['Resumir conversación (OpenAI)', 'Leer Leads (Sheets)'],
    ['Leer Leads (Sheets)', 'Preparar fila del lead'], ['Preparar fila del lead', '¿Lead nuevo?'],
    ['¿Lead nuevo?', 'Agregar lead (Sheets)', 0], ['¿Lead nuevo?', 'Actualizar lead (Sheets)', 1],
    ['Agregar lead (Sheets)', 'Avisar en Telegram'], ['Actualizar lead (Sheets)', 'Avisar en Telegram'],
    ['Avisar en Telegram', 'Registrar aviso (SQL)'], ['Registrar aviso (SQL)', 'Respuesta: contacto registrado'],
  ]),
  settings: { executionOrder: 'v1', saveDataErrorExecution: 'all', saveDataSuccessExecution: 'all', timezone: 'America/Bogota' },
};

const path = 'workflows/FLOW · Contacto con asesor.json';
if (existsSync(path)) wf.id = JSON.parse(readFileSync(path, 'utf8')).id;
writeFileSync(path, JSON.stringify(wf, null, 2) + '\n');
console.log('escrito', path, wf.id || '(nuevo)');
