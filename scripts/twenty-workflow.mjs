#!/usr/bin/env node
// Genera «FLOW · Registrar en Twenty» (sub-workflow): deja un lead de WhatsApp en el CRM (Twenty).
//   persona (por teléfono; si no existe, la crea y la liga a la empresa importada con ese teléfono)
//   → oportunidad en el embudo Comercial (reusa la abierta o abre una en «Nuevo»)
//   → empresa «Sin trabajar»/«Descartada» pasa a «En proceso» → nota en la oportunidad.
// La usan «FLOW · Diagnóstico» (source = diagnostico) y «FLOW · Contacto con asesor» (source = asesor).
// Mismo criterio que el website (automaverso-web: server/services/contact.ts).
// Twenty se alcanza por la red interna del VPS (automaverso_internal), sin pasar por Cloudflare Access.
// Conserva el id si el JSON ya existe.
import { readFileSync, writeFileSync, existsSync } from 'node:fs';

export const TWENTY = { httpHeaderAuth: { id: process.env.TWENTY_CREDENTIAL_ID || 'PENDIENTE', name: 'Twenty CRM (Bearer)' } };
const BASE = 'http://twenty-server:3000/rest';
const SUB_PATH = 'workflows/FLOW · Registrar en Twenty.json';
const INPUTS = [['source', 'string'], ['wa_id', 'string'], ['name', 'string'], ['contact_channel', 'string'],
  ['contact_phone', 'string'], ['note_title', 'string'], ['note', 'string'], ['diag', 'object']];

/** Nodo «Registrar en Twenty» para los flujos que llaman a este sub-workflow (values: expresiones por entrada). */
export const twentyCall = (id, pos, values) => ({
  id, name: 'Registrar en Twenty', type: 'n8n-nodes-base.executeWorkflow', typeVersion: 1.2, position: pos,
  onError: 'continueRegularOutput', alwaysOutputData: true,
  parameters: {
    workflowId: { __rl: true, mode: 'id', value: existsSync(SUB_PATH) ? JSON.parse(readFileSync(SUB_PATH, 'utf8')).id : 'PENDIENTE' },
    workflowInputs: { mappingMode: 'defineBelow', value: values, matchingColumns: [],
      schema: INPUTS.map(([k, type]) => ({ id: k, displayName: k, required: false, defaultMatch: false, display: true, canBeUsedToMatch: true, type })),
      attemptToConvertTypes: false, convertFieldsToString: false },
    options: {},
  },
});
const P = "$('Preparar').first().json";

const http = (id, name, pos, parameters, extra = {}) => ({
  id, name, type: 'n8n-nodes-base.httpRequest', typeVersion: 4.2, position: pos, credentials: TWENTY,
  retryOnFail: true, maxTries: 3, waitBetweenTries: 2000, ...extra,
  parameters: { authentication: 'genericCredentialType', genericAuthType: 'httpHeaderAuth', options: { timeout: 15000 }, ...parameters },
});
const get = (id, name, pos, url) => http(id, name, pos, { url }, { alwaysOutputData: true });
const post = (id, name, pos, url, body) =>
  http(id, name, pos, { method: 'POST', url, sendBody: true, specifyBody: 'json', jsonBody: `={{ JSON.stringify(${body}) }}` });
const code = (id, name, pos, jsCode) => ({ id, name, type: 'n8n-nodes-base.code', typeVersion: 2, position: pos, parameters: { jsCode } });
const connect = (pairs) => {
  const c = {};
  for (const [from, to, out = 0] of pairs) {
    c[from] ??= { main: [] };
    while (c[from].main.length <= out) c[from].main.push([]);
    c[from].main[out].push({ node: to, type: 'main', index: 0 });
  }
  return c;
};

const PREPARE = String.raw`// Why Code: normalizar el teléfono al formato de Twenty (indicativo + número) y armar los filtros.
const i = $input.first().json;
const CODES = [['57','CO'],['34','ES'],['52','MX'],['54','AR'],['55','BR'],['56','CL'],['58','VE'],['51','PE'],['53','CU'],
  ['591','BO'],['593','EC'],['595','PY'],['598','UY'],['502','GT'],['503','SV'],['504','HN'],['505','NI'],['506','CR'],
  ['507','PA'],['509','HT'],['351','PT'],['44','GB'],['49','DE'],['33','FR'],['39','IT'],['1','US']]
  .sort((a, b) => b[0].length - a[0].length);
const phone = (raw) => {
  const d = String(raw || '').replace(/\D/g, '');
  const c = CODES.find(([dial]) => d.startsWith(dial) && d.length - dial.length >= 6);
  return c ? { primaryPhoneNumber: d.slice(c[0].length), primaryPhoneCountryCode: c[1], primaryPhoneCallingCode: '+' + c[0] }
           : { primaryPhoneNumber: d, primaryPhoneCountryCode: '', primaryPhoneCallingCode: '' };
};
const wa = phone(i.wa_id);
const q = (s) => encodeURIComponent(s);
return [{ json: {
  ...i,
  diag: i.diag && typeof i.diag === 'object' ? i.diag : null,
  waPhone: wa,
  contactPhone: phone(i.contact_phone || i.wa_id),
  contactE164: '+' + String(i.contact_phone || i.wa_id).replace(/\D/g, ''),
  personFilter: q('phones.primaryPhoneNumber[eq]:"' + wa.primaryPhoneNumber + '"'),
  companyFilter: q('telefono.primaryPhoneNumber[eq]:"' + wa.primaryPhoneNumber + '"'),
} }];`;

const PERSON = String.raw`// Why Code: decidir si la persona se crea o se actualiza (upsert por id) sin pisar lo que ya tiene.
const p = $('Preparar').first().json;
const found = ($('Buscar persona').first().json.data?.people || [])[0];
const company = ($('Buscar empresa').first().json.data?.companies || [])[0];
const LEVEL = { encaja: 'ALTO', dudoso: 'MEDIO', no_califica: 'BAJO' };
const companyId = found?.companyId || company?.id || null;
const [firstName = '', ...rest] = String(p.name || '').trim().split(/\s+/);
const body = found ? { id: found.id } : {
  name: { firstName: firstName || 'WhatsApp', lastName: firstName ? rest.join(' ') : '+' + String(p.wa_id) },
  phones: p.waPhone, canal: 'WHATSAPP', leadId: 'WA-' + p.wa_id,
};
if (found && p.name && (!found.name?.firstName || found.name.firstName === 'WhatsApp')) body.name = { firstName, lastName: rest.join(' ') };
if (!found?.companyId && companyId) body.companyId = companyId;
if (!found || ['SIN_TRABAJAR', 'DESCARTADA', '', null, undefined].includes(found.estado)) body.estado = 'EN_PROCESO';
if (p.diag?.qualification && LEVEL[p.diag.qualification]) body.nivel = LEVEL[p.diag.qualification];
return [{ json: { body, isNew: !found, companyId, companyEstado: company?.id === companyId ? company?.estado : null } }];`;

const OPPORTUNITY = String.raw`// Why Code: armar la oportunidad (nueva en «Nuevo» o la abierta) según venga del diagnóstico o del asesor.
const p = $('Preparar').first().json;
const person = $('Guardar persona').first().json.data.createPerson;
const plan = $('Datos de la persona').first().json;
const open = ($('Buscar oportunidad abierta').first().json.data?.opportunities || [])[0];
const name = [person.name?.firstName, person.name?.lastName].filter(Boolean).join(' ');
const company = ($('Buscar empresa').first().json.data?.companies || [])[0];
const body = open ? { id: open.id } : {
  name: (company?.id && company.id === plan.companyId ? company.name : name) + ' · Comercial', proceso: 'COMERCIAL', etapaComercial: 'NUEVO',
  ...(plan.companyId ? { companyId: plan.companyId } : {}),
};
// La abierta se creó antes de saber el nombre («WhatsApp +57…»): ahora que lo sabemos, se renombra.
if (open && /^WhatsApp \+/.test(open.name || '') && name && !name.startsWith('WhatsApp')) body.name = name + ' · Comercial';
body.pointOfContactId = person.id;
body.fechaProximaAccion = new Date().toISOString();
if (p.source === 'asesor') {
  const call = p.contact_channel === 'phone_call' || p.contact_channel === 'whatsapp_call';
  body.contactarPor = call ? 'LLAMADA' : 'WHATSAPP';
  body.telefonoContacto = p.contactPhone;
  body.proximaAccion = ({ phone_call: 'Llamar al celular', whatsapp_call: 'Llamar por WhatsApp', chat: 'Escribir por WhatsApp' }[p.contact_channel] || 'Contactar')
    + ' al ' + p.contactE164 + ' (pidió un asesor por WhatsApp)';
} else {
  body.proximaAccion = 'Escribir por WhatsApp al ' + p.contactE164 + ' (hizo el diagnóstico por WhatsApp)';
  if (!open) { body.contactarPor = 'WHATSAPP'; body.telefonoContacto = p.waPhone; }
}
if (p.diag) {
  if (p.diag.dolor) body.diagDolorPrincipal = p.diag.dolor;
  if (p.diag.ahorroUsd) body.diagAhorroAnualUsd = Number(p.diag.ahorroUsd);
  if (p.diag.plazoPais) body.diagPresupuestoPlazo = p.diag.plazoPais;
}
return [{ json: { body, reused: !!open, personId: person.id, leadId: person.leadId || '', personName: name } }];`;

const OPEN_STAGES = ['NUEVO', 'POR_CONTACTAR', 'CONTACTADO', 'DIAGNOSTICO_AGENDADO', 'DIAGNOSTICO_HECHO', 'PROPUESTA_ENVIADA', 'NEGOCIACION', 'NUTRIR'];
const OPEN_FILTER = `encodeURIComponent('and(proceso[eq]:"COMERCIAL",etapaComercial[in]:[${OPEN_STAGES.map((s) => `"${s}"`).join(',')}],or(pointOfContactId[eq]:"' + $json.data.createPerson.id + '"' + ($('Datos de la persona').first().json.companyId ? ',companyId[eq]:"' + $('Datos de la persona').first().json.companyId + '"' : '') + '))')`;
const O = "$('Datos de la oportunidad').first().json";
const OPP = "$('Guardar oportunidad').first().json.data.createOpportunity";

const wf = {
  name: 'FLOW · Registrar en Twenty',
  nodes: [
    { id: 't1', name: 'Entrada', type: 'n8n-nodes-base.executeWorkflowTrigger', typeVersion: 1.3, position: [0, 300],
      parameters: { inputSource: 'workflowInputs', workflowInputs: { values: [
        ...INPUTS.map(([name, type]) => ({ name, type }))] } } },
    code('t2', 'Preparar', [220, 300], PREPARE),
    get('t3', 'Buscar persona', [440, 300], `=${BASE}/people?limit=1&depth=0&filter={{ $json.personFilter }}`),
    get('t4', 'Buscar empresa', [660, 300], `=${BASE}/companies?limit=1&depth=0&filter={{ ${P}.companyFilter }}`),
    code('t5', 'Datos de la persona', [880, 300], PERSON),
    post('t6', 'Guardar persona', [1100, 300], `${BASE}/people?upsert=true`, '$json.body'),
    get('t7', 'Buscar oportunidad abierta', [1320, 300], `=${BASE}/opportunities?limit=1&depth=0&order_by=createdAt[DescNullsLast]&filter={{ ${OPEN_FILTER} }}`),
    code('t8', 'Datos de la oportunidad', [1540, 300], OPPORTUNITY),
    post('t9', 'Guardar oportunidad', [1760, 300], `${BASE}/opportunities?upsert=true`, '$json.body'),
    { id: 't10', name: '¿Reabrir empresa?', type: 'n8n-nodes-base.if', typeVersion: 2.2, position: [1980, 300],
      parameters: { conditions: { options: { caseSensitive: true, leftValue: '', typeValidation: 'loose', version: 2 },
        conditions: [{ id: 't10c', leftValue: `={{ !!$('Datos de la persona').first().json.companyId && ['SIN_TRABAJAR', 'DESCARTADA', '', null, undefined].includes($('Datos de la persona').first().json.companyEstado) }}`,
          rightValue: '', operator: { type: 'boolean', operation: 'true', singleValue: true } }], combinator: 'and' }, options: {} } },
    post('t11', 'Empresa en proceso', [2200, 200], `${BASE}/companies?upsert=true`,
      `{ id: $('Datos de la persona').first().json.companyId, estado: 'EN_PROCESO' }`),
    { id: 't12', name: 'Juntar', type: 'n8n-nodes-base.merge', typeVersion: 3.2, position: [2420, 300],
      parameters: { mode: 'chooseBranch', chooseBranchMode: 'waitForAll', output: 'empty' } },
    post('t13', 'Crear nota', [2640, 300], `${BASE}/notes`,
      `{ title: ${P}.note_title || 'WhatsApp', bodyV2: { markdown: ${P}.note || '', blocknote: null } }`, { onError: 'continueRegularOutput' }),
    post('t14', 'Enlazar nota', [2860, 300], `${BASE}/noteTargets`,
      `{ noteId: $json.data.createNote.id, targetOpportunityId: ${OPP}.id }`, { onError: 'continueRegularOutput' }),
    { id: 't15', name: 'Resultado', type: 'n8n-nodes-base.set', typeVersion: 3.4, position: [3080, 300],
      parameters: { assignments: { assignments: [
        { id: 'r1', name: 'personId', type: 'string', value: `={{ ${O}.personId }}` },
        { id: 'r2', name: 'leadId', type: 'string', value: `={{ ${O}.leadId }}` },
        { id: 'r3', name: 'opportunityId', type: 'string', value: `={{ ${OPP}.id }}` },
        { id: 'r4', name: 'opportunityUrl', type: 'string', value: `={{ 'https://crm.automaverso.com/object/opportunity/' + ${OPP}.id }}` },
        { id: 'r5', name: 'isNewPerson', type: 'boolean', value: `={{ $('Datos de la persona').first().json.isNew }}` },
        { id: 'r6', name: 'reused', type: 'boolean', value: `={{ ${O}.reused }}` },
      ] }, options: {} } },
    { id: 'note', name: 'Nota', type: 'n8n-nodes-base.stickyNote', typeVersion: 1, position: [-40, -60],
      parameters: { width: 1000, height: 280, content: '## FLOW · Registrar en Twenty\nEntradas: `source` (diagnostico | asesor), `wa_id`, `name`, `contact_channel` (chat | whatsapp_call | phone_call), `contact_phone`, `note_title`, `note` (markdown), `diag` ({ dolor, ahorroUsd, plazoPais, qualification }).\n1. Persona por teléfono (si no existe: se crea con Lead ID `WA-<número>`, canal WhatsApp, y se liga a la empresa importada que tenga ese teléfono).\n2. Oportunidad del embudo **Comercial**: reusa la abierta (de la persona o su empresa) o abre una en **Nuevo**, con contacto, próxima acción y campos del diagnóstico.\n3. Empresa *Sin trabajar*/*Descartada* → *En proceso*. Nota en la oportunidad.\nDevuelve `{ personId, leadId, opportunityId, opportunityUrl, isNewPerson, reused }`. Twenty: `http://twenty-server:3000` (red interna).' } },
  ],
  connections: connect([
    ['Entrada', 'Preparar'], ['Preparar', 'Buscar persona'], ['Buscar persona', 'Buscar empresa'],
    ['Buscar empresa', 'Datos de la persona'], ['Datos de la persona', 'Guardar persona'],
    ['Guardar persona', 'Buscar oportunidad abierta'], ['Buscar oportunidad abierta', 'Datos de la oportunidad'],
    ['Datos de la oportunidad', 'Guardar oportunidad'], ['Guardar oportunidad', '¿Reabrir empresa?'],
    ['¿Reabrir empresa?', 'Empresa en proceso', 0], ['¿Reabrir empresa?', 'Juntar', 1], ['Empresa en proceso', 'Juntar'],
    ['Juntar', 'Crear nota'], ['Crear nota', 'Enlazar nota'], ['Enlazar nota', 'Resultado'],
  ]),
  settings: { executionOrder: 'v1', saveDataErrorExecution: 'all', saveDataSuccessExecution: 'all', timezone: 'America/Bogota' },
};

if (process.argv[1]?.endsWith('twenty-workflow.mjs')) {
  const path = SUB_PATH;
  if (existsSync(path)) {
    const prev = JSON.parse(readFileSync(path, 'utf8'));
    wf.id = prev.id;
    const cred = prev.nodes.find((n) => n.credentials?.httpHeaderAuth)?.credentials.httpHeaderAuth;
    if (cred && !process.env.TWENTY_CREDENTIAL_ID) for (const n of wf.nodes) if (n.credentials) n.credentials = { httpHeaderAuth: cred };
  }
  writeFileSync(path, JSON.stringify(wf, null, 2) + '\n');
  console.log('escrito', path, wf.id || '(nuevo)');
}
