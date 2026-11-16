#!/usr/bin/env node
// Genera los workflows del flujo "Ver ejemplos":
//   EX · 1 Sincronizar ejemplos   Drive (videos + catálogo) → Meta (media_id) → chatbot.examples
//   TOOL · Enviar ejemplo         siguiente video no visto + botones "Ver otro ejemplo" / "Hablar con un asesor"
// Conserva el id de cada workflow si el JSON ya existe (para que push actualice en vez de crear).
import { readFileSync, writeFileSync, existsSync } from 'node:fs';

const PG = { postgres: { id: 'aV6poYyo4OBcJu8E', name: 'Postgres VPS (chatbot)' } };
const WA = { httpHeaderAuth: { id: '30aSXJ9QwShLDa9s', name: 'WhatsApp Graph API (Bearer)' } };
const GD = { googleApi: { id: 'WSHDp2ZQ4qMFpLOi', name: 'Google Drive KB (cuenta de servicio n8n-kb)' } };
const GRAPH = 'https://graph.facebook.com/v23.0';
export const BTN_OTRO = 'Ver otro ejemplo';
export const BTN_ASESOR = 'Hablar con un asesor';

const pg = (id, name, pos, query, params, extra = {}) => ({
  id, name, type: 'n8n-nodes-base.postgres', typeVersion: 2.7, position: pos,
  retryOnFail: true, maxTries: 3, waitBetweenTries: 1000, credentials: PG, ...extra,
  parameters: { operation: 'executeQuery', query, options: params ? { queryReplacement: params } : {} },
});
const http = (id, name, pos, parameters, credentials, extra = {}) => ({
  id, name, type: 'n8n-nodes-base.httpRequest', typeVersion: 4.2, position: pos, credentials, ...extra, parameters,
});
const graphJson = (id, name, pos, body, extra = {}) => http(id, name, pos, {
  method: 'POST', url: `=${GRAPH}/{{ $('Elegir ejemplo (SQL)').first().json.phone_number_id }}/messages`,
  authentication: 'genericCredentialType', genericAuthType: 'httpHeaderAuth',
  sendBody: true, specifyBody: 'json', jsonBody: `={{ JSON.stringify(${body}) }}`, options: {},
}, WA, { retryOnFail: true, maxTries: 3, waitBetweenTries: 2000, ...extra });
const set = (id, name, pos, value) => ({
  id, name, type: 'n8n-nodes-base.set', typeVersion: 3.4, position: pos,
  parameters: { assignments: { assignments: [{ id: id + 'a', name: 'response', type: 'string', value }] }, options: {} },
});
const note = (content, pos, width = 640, height = 260) => ({
  id: 'note', name: 'Nota', type: 'n8n-nodes-base.stickyNote', typeVersion: 1, position: pos, parameters: { content, width, height },
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
const save = (file, wf) => {
  const path = `workflows/${file}.json`;
  if (existsSync(path)) wf.id = JSON.parse(readFileSync(path, 'utf8')).id;
  writeFileSync(path, JSON.stringify(wf, null, 2) + '\n');
  console.log('escrito', path, wf.id || '(nuevo)');
};

// Botones interactivos como literal JS con espacios (un "}}" cerraría la expresión de n8n)
const button = (id, title) => `{ type: 'reply', reply: { id: '${id}', title: '${title}' } }`;
const interactive = (bodyExpr, buttonsExpr) =>
  `{ messaging_product: 'whatsapp', recipient_type: 'individual', to: $('Elegir ejemplo (SQL)').first().json.wa_id, type: 'interactive', interactive: { type: 'button', body: { text: ${bodyExpr} }, action: { buttons: ${buttonsExpr} } } }`;
const registerInteractive = (bodyExpr, labelsExpr) =>
  `={{ [ $json.messages[0].id, $('Elegir ejemplo (SQL)').first().json.wa_id, ${bodyExpr}, ${labelsExpr} ] }}`;
const REGISTER_INTERACTIVE_SQL = "SELECT r.* FROM chatbot.register_outbound(jsonb_build_object(\n  'wamid', $1, 'wa_id', $2, 'type', 'interactive', 'text', $3,\n  'agent_text', $3 || E'\\n[Botones: ' || $4 || ']')) r";

// ============================================================ TOOL · Enviar ejemplo
const MORE = "$('Elegir ejemplo (SQL)').first().json.remaining > 0";
const BODY_NEXT = `(${MORE} ? '¿Quieres ver otro ejemplo o prefieres avanzar con nosotros?' : '¿Te gustaría avanzar con nosotros?')`;
const BTNS_NEXT = `(${MORE} ? [ ${button('otro_ejemplo', BTN_OTRO)}, ${button('asesor', BTN_ASESOR)} ] : [ ${button('asesor', BTN_ASESOR)} ])`;
const LABELS_NEXT = `(${MORE} ? '${BTN_OTRO} | ${BTN_ASESOR}' : '${BTN_ASESOR}')`;
const BODY_NONE = "($('Elegir ejemplo (SQL)').first().json.total > 0 ? 'Ya viste todos nuestros ejemplos.\\n\\nSi quieres, un asesor te muestra cómo aplicarlo a *tu negocio*.' : 'Por ahora no tengo videos de ejemplo disponibles.\\n\\nUn asesor puede mostrarte casos según *tu negocio*.')";

const tool = {
  name: 'TOOL · Enviar ejemplo',
  nodes: [
    { id: 't1', name: 'Entrada', type: 'n8n-nodes-base.executeWorkflowTrigger', typeVersion: 1.3, position: [0, 300],
      parameters: { inputSource: 'workflowInputs', workflowInputs: { values: [{ name: 'wa_id', type: 'string' }, { name: 'tema', type: 'string' }] } } },
    pg('t2', 'Elegir ejemplo (SQL)', [220, 300],
      "SELECT n.*, $1::text AS wa_id, chatbot.config('wa_phone_number_id') AS phone_number_id\n  FROM chatbot.next_example($1, NULLIF($2, '')) n",
      "={{ [ $json.wa_id, $json.tema || '' ] }}"),
    { id: 't3', name: '¿Hay ejemplo por ver?', type: 'n8n-nodes-base.if', typeVersion: 2.2, position: [440, 300],
      parameters: { conditions: { options: { caseSensitive: true, leftValue: '', typeValidation: 'loose', version: 2 },
        conditions: [{ id: 'h1', leftValue: '={{ $json.example_id ?? 0 }}', rightValue: 0, operator: { type: 'number', operation: 'gt' } }],
        combinator: 'and' }, options: {} } },
    graphJson('t4', 'Enviar video', [680, 180],
      "{ messaging_product: 'whatsapp', recipient_type: 'individual', to: $json.wa_id, type: 'video', video: { id: $json.meta_media_id, caption: $json.caption } }",
      { onError: 'continueErrorOutput' }),
    pg('t5', 'Registrar video (SQL)', [920, 120],
      "SELECT r.*, chatbot.example_sent($2, $5::int, $1) AS seen FROM chatbot.register_outbound(jsonb_build_object(\n  'wamid', $1, 'wa_id', $2, 'type', 'video', 'caption', $3,\n  'agent_text', '[Video de ejemplo enviado: ' || $4 || ']', 'raw', $6::jsonb)) r",
      "={{ [ $json.messages[0].id, $('Elegir ejemplo (SQL)').first().json.wa_id, $('Elegir ejemplo (SQL)').first().json.caption, $('Elegir ejemplo (SQL)').first().json.title, $('Elegir ejemplo (SQL)').first().json.example_id, JSON.stringify($json) ] }}"),
    // El video pesa más que un texto: si los botones salen enseguida llegan ANTES que el video.
    // Se espera la confirmación de entrega de Meta (status delivered/read, la registra WA · 1) cada 2 s, máx. ~20 s.
    { id: 't5a', name: 'Esperar entrega (2 s)', type: 'n8n-nodes-base.wait', typeVersion: 1.1, position: [1020, -60],
      webhookId: 'b3a1f6e2-7c4d-4e8a-9f21-6d5c3b2a1e09', parameters: { resume: 'timeInterval', amount: 2, unit: 'seconds' } },
    pg('t5b', 'Estado del video (SQL)', [1240, -60],
      "SELECT status FROM chatbot.messages WHERE wamid = $1",
      "={{ [ $('Enviar video').first().json.messages[0].id ] }}", { alwaysOutputData: true }),
    { id: 't5c', name: '¿Video entregado?', type: 'n8n-nodes-base.if', typeVersion: 2.2, position: [1460, -60],
      parameters: { conditions: { options: { caseSensitive: true, leftValue: '', typeValidation: 'loose', version: 2 },
        conditions: [{ id: 'v1', leftValue: "={{ ['delivered', 'read'].includes($json.status) || $runIndex >= 9 }}", rightValue: '',
          operator: { type: 'boolean', operation: 'true', singleValue: true } }], combinator: 'and' }, options: {} } },
    graphJson('t6', 'Enviar botones', [1140, 120], interactive(BODY_NEXT, BTNS_NEXT)),
    pg('t7', 'Registrar botones (SQL)', [1360, 120], REGISTER_INTERACTIVE_SQL, registerInteractive(BODY_NEXT, LABELS_NEXT)),
    set('t8', 'Respuesta: enviado', [1580, 120],
      "=ENVIADO: el usuario ya recibió el video «{{ $('Elegir ejemplo (SQL)').first().json.title }}» y los botones para seguir. No agregues texto."),
    pg('t9', 'Invalidar video (SQL)', [920, 340],
      'SELECT chatbot.example_media_invalid($1::int, $2) AS ok',
      "={{ [ $('Elegir ejemplo (SQL)').first().json.example_id, JSON.stringify($json.error || $json).slice(0, 500) ] }}"),
    set('t10', 'Respuesta: no enviado', [1140, 340],
      'NO_ENVIADO: el video no se pudo enviar en este momento. Discúlpate en una frase y ofrece hablar con un asesor.'),
    graphJson('t11', 'Avisar sin más ejemplos', [680, 520], interactive(BODY_NONE, `[ ${button('asesor', BTN_ASESOR)} ]`)),
    pg('t12', 'Registrar aviso (SQL)', [920, 520], REGISTER_INTERACTIVE_SQL, registerInteractive(BODY_NONE, `'${BTN_ASESOR}'`)),
    set('t13', 'Respuesta: sin más', [1140, 520],
      'SIN_MAS_EJEMPLOS: ya se le dijo al usuario que no hay más videos y se le ofreció un asesor. No agregues texto.'),
    note('## TOOL · Enviar ejemplo\nEntradas: `wa_id`, `tema` (opcional: industria o proceso del cliente).\n1. `chatbot.next_example`: siguiente video **no visto** por ese número, priorizando el tema.\n2. Envía el video (media_id ya subido por **EX · 1**) con su texto, lo registra y marca como visto.\n3. Envía botones *Ver otro ejemplo* / *Hablar con un asesor* (solo el segundo si era el último).\n4. Si Meta rechaza el media_id, lo invalida (EX · 1 lo vuelve a subir) y devuelve NO_ENVIADO.\nDevuelve `{ response }` con ENVIADO / SIN_MAS_EJEMPLOS / NO_ENVIADO.', [-40, -40], 700, 300),
  ],
  connections: connect([
    ['Entrada', 'Elegir ejemplo (SQL)'], ['Elegir ejemplo (SQL)', '¿Hay ejemplo por ver?'],
    ['¿Hay ejemplo por ver?', 'Enviar video', 0], ['¿Hay ejemplo por ver?', 'Avisar sin más ejemplos', 1],
    ['Enviar video', 'Registrar video (SQL)', 0], ['Enviar video', 'Invalidar video (SQL)', 1],
    ['Registrar video (SQL)', 'Esperar entrega (2 s)'], ['Esperar entrega (2 s)', 'Estado del video (SQL)'],
    ['Estado del video (SQL)', '¿Video entregado?'], ['¿Video entregado?', 'Enviar botones', 0], ['¿Video entregado?', 'Esperar entrega (2 s)', 1],
    ['Enviar botones', 'Registrar botones (SQL)'], ['Registrar botones (SQL)', 'Respuesta: enviado'],
    ['Invalidar video (SQL)', 'Respuesta: no enviado'],
    ['Avisar sin más ejemplos', 'Registrar aviso (SQL)'], ['Registrar aviso (SQL)', 'Respuesta: sin más'],
  ]),
  settings: { executionOrder: 'v1', saveDataErrorExecution: 'all', saveDataSuccessExecution: 'all' },
};

// ============================================================ EX · 1 Sincronizar ejemplos
const sync = {
  name: 'EX · 1 Sincronizar ejemplos',
  nodes: [
    { id: 's1', name: 'Cada hora', type: 'n8n-nodes-base.scheduleTrigger', typeVersion: 1.2, position: [0, 200],
      parameters: { rule: { interval: [{ field: 'hours', hoursInterval: 1 }] } } },
    { id: 's2', name: 'Sincronizar ahora (manual)', type: 'n8n-nodes-base.manualTrigger', typeVersion: 1, position: [0, 400], parameters: {} },
    { id: 's2b', name: 'Desde otro workflow', type: 'n8n-nodes-base.executeWorkflowTrigger', typeVersion: 1.1, position: [0, 600],
      parameters: { inputSource: 'passthrough' } },
    pg('s3', 'Configuración (SQL)', [220, 300],
      "SELECT chatbot.config('examples_folder_id') AS folder, chatbot.config('wa_phone_number_id') AS phone_number_id"),
    http('s4', 'Listar carpeta (Drive)', [440, 300], {
      url: "={{ 'https://www.googleapis.com/drive/v3/files?pageSize=200&fields=files(id,name,mimeType,md5Checksum,size)&q=' + encodeURIComponent(\"'\" + $json.folder + \"' in parents and trashed=false\") }}",
      authentication: 'predefinedCredentialType', nodeCredentialType: 'googleApi', options: {},
    }, GD, { retryOnFail: true, maxTries: 3, waitBetweenTries: 2000 }),
    http('s5', 'Exportar catálogo (CSV)', [660, 300], {
      url: "={{ 'https://www.googleapis.com/drive/v3/files/' + ($json.files.find(f => f.mimeType === 'application/vnd.google-apps.spreadsheet' && f.name.startsWith('_')) || { id: 'sin-catalogo' }).id + '/export?mimeType=text/csv' }}",
      authentication: 'predefinedCredentialType', nodeCredentialType: 'googleApi',
      options: { response: { response: { responseFormat: 'file', outputPropertyName: 'data' } } },
    }, GD, { retryOnFail: true, maxTries: 3, waitBetweenTries: 2000 }),
    { id: 's6', name: 'Leer catálogo', type: 'n8n-nodes-base.extractFromFile', typeVersion: 1, position: [880, 300],
      parameters: { operation: 'csv', binaryPropertyName: 'data', options: { headerRow: true } } },
    pg('s7', 'Planificar (SQL)', [1100, 300],
      'SELECT * FROM chatbot.examples_plan($1::jsonb, $2::jsonb)',
      "={{ [ JSON.stringify($('Listar carpeta (Drive)').first().json.files), JSON.stringify($('Leer catálogo').all().map(i => i.json)) ] }}",
      { executeOnce: true }),
    http('s8', 'Descargar video (Drive)', [1320, 300], {
      url: '=https://www.googleapis.com/drive/v3/files/{{ $json.drive_file_id }}?alt=media',
      authentication: 'predefinedCredentialType', nodeCredentialType: 'googleApi',
      options: { response: { response: { responseFormat: 'file', outputPropertyName: 'data' } } },
    }, GD, { retryOnFail: true, maxTries: 3, waitBetweenTries: 2000, onError: 'continueRegularOutput' }),
    http('s9', 'Subir a WhatsApp', [1540, 300], {
      method: 'POST', url: `=${GRAPH}/{{ $('Configuración (SQL)').first().json.phone_number_id }}/media`,
      authentication: 'genericCredentialType', genericAuthType: 'httpHeaderAuth', sendBody: true, contentType: 'multipart-form-data',
      bodyParameters: { parameters: [
        { parameterType: 'formBinaryData', name: 'file', inputDataFieldName: 'data' },
        { name: 'type', value: "={{ $('Planificar (SQL)').item.json.mime_type || 'video/mp4' }}" },
        { name: 'messaging_product', value: 'whatsapp' } ] },
      options: { timeout: 120000 },
    }, WA, { retryOnFail: true, maxTries: 3, waitBetweenTries: 5000, onError: 'continueRegularOutput' }),
    pg('s10', 'Registrar subida (SQL)', [1760, 300],
      'SELECT chatbot.example_uploaded($1::int, $2, $3) AS ok, $4::text AS file_name',
      "={{ [ $('Planificar (SQL)').item.json.id, $json.id || '', $json.id ? '' : JSON.stringify($json.error || $json).slice(0, 500), $('Planificar (SQL)').item.json.file_name ] }}"),
    note('## EX · 1 Sincronizar ejemplos\nCarpeta de Drive `examples_folder_id` (en `chatbot.app_config`) con los videos y el Sheet **_Catálogo de ejemplos** (archivo · titulo · descripcion · tema · activo · orden).\n- Cada hora: lista la carpeta, lee el catálogo y `chatbot.examples_plan` decide qué subir.\n- Sube a Meta solo lo nuevo, lo cambiado o lo que vence (media_id dura 30 días; se renueva a los 25).\n- Sin cambios ⇒ termina en «Planificar» (no se guarda la ejecución).\n- Videos > 16 MB se rechazan con error en `chatbot.v_examples`.', [-40, -40], 760, 260),
  ],
  connections: connect([
    ['Cada hora', 'Configuración (SQL)'], ['Sincronizar ahora (manual)', 'Configuración (SQL)'], ['Desde otro workflow', 'Configuración (SQL)'],
    ['Configuración (SQL)', 'Listar carpeta (Drive)'], ['Listar carpeta (Drive)', 'Exportar catálogo (CSV)'],
    ['Exportar catálogo (CSV)', 'Leer catálogo'], ['Leer catálogo', 'Planificar (SQL)'],
    ['Planificar (SQL)', 'Descargar video (Drive)'], ['Descargar video (Drive)', 'Subir a WhatsApp'], ['Subir a WhatsApp', 'Registrar subida (SQL)'],
  ]),
  settings: { executionOrder: 'v1', saveDataErrorExecution: 'all', saveDataSuccessExecution: 'none', timezone: 'America/Bogota' },
};

if (process.argv[1]?.endsWith('examples-workflows.mjs')) {
  save('TOOL · Enviar ejemplo', tool);
  save('EX · 1 Sincronizar ejemplos', sync);
}
