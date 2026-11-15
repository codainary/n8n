#!/usr/bin/env node
// Genera «FLOW · Diagnóstico» (sub-workflow):
//   paso (chatbot.diagnosis_step) → envía los mensajes (texto / botones / lista)
//   → al terminar: cálculo (fórmula v2 del website) → reporte + botones → Sheet (Leads + Diagnósticos) → Telegram.
// El cálculo replica automaverso-web: lib/assessment/report.ts (FORMULA_VERSION v2),
// server/services/qualification.ts (SCORING_VERSION v2) y lib/assessment/suggestions.ts. Si cambian allá, cambiar aquí.
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

const CALCULATE = String.raw`// Why Code: réplica exacta de la fórmula del website (report.ts v2), la calificación (qualification.ts v2)
// y las sugerencias (suggestions.ts); además arma el reporte de WhatsApp y el aviso de Telegram.
const step = $('Paso (SQL)').first().json;
const a = step.answers;

// ---- options.ts
const PEOPLE_MID = { '1': 1, '2-3': 2.5, '4-10': 7, '10+': 12 };
const HOURS_MID = { lt2: 1, '2-5': 3.5, '5-10': 7.5, '10+': 12 };
const HOURLY_COST_MID = { lt5: 4, '5-10': 7.5, '10-20': 15, '20-40': 30, '40+': 50 };
const REFERENCE_HOURLY_COST = { co: 6, latam: 7, us: 30, es: 18, other: 10 };
const EMPLOYER_LOAD = { co: 1.52, latam: 1.4, us: 1.25, es: 1.32, other: 1.3 };
const OVERTIME_SURCHARGE = { co: 0.25, latam: 0.25, us: 0.5, es: 0.25, other: 0.25 };
const COP_PER_USD = 4000;
// ---- report.ts (v2)
const FORMULA_VERSION = 'v2', WORK_WEEKS = 46, HOURS_PER_WORKDAY = 8, HOURS_PER_FTE_YEAR = 46 * 40, PILOT_USD = 1000;
const REPETITION_SHARE = { always: 0.75, mostly: 0.6, varies: 0.4 };
const PAPER_ONLY_FACTOR = 0.8, RANGE_LOW = 0.85, RANGE_HIGH = 1.1, MAX_SHARE = 0.85;
const REWORK_SHARE = 0.12, COORDINATION_SHARE = 0.1, LEAD_COST_FACTOR = 1.5, OVERTIME_SHARE = 0.2;
const POTENTIAL_HIGH = 500, POTENTIAL_MEDIUM = 150;

const tools = a.tools || [], pains = a.pains || [], areas = a.areas || [];
const weekly = a.hours === 'unknown' ? null : PEOPLE_MID[a.people] * HOURS_MID[a.hours];
const paperOnly = tools.length > 0 && tools.every(t => t === 'paper');
const A = REPETITION_SHARE[a.repetition] * (paperOnly ? PAPER_ONLY_FACTOR : 1);
const share = { min: A * RANGE_LOW, max: Math.min(MAX_SHARE, A * RANGE_HIGH) };
const automatablePct = { min: Math.round(share.min * 100), max: Math.round(share.max * 100) };
const load = a.hourlyCost === 'unknown' ? EMPLOYER_LOAD[a.country] : null;
const hourlyCost = a.hourlyCost === 'unknown'
  ? { usd: Math.round(REFERENCE_HOURLY_COST[a.country] * (load ?? 1) * 10) / 10, source: 'reference' }
  : { usd: HOURLY_COST_MID[a.hourlyCost], source: 'visitor' };
const currency = a.country === 'co' ? { code: 'COP', perUsd: COP_PER_USD } : { code: 'USD', perUsd: 1 };
const mid = (r) => (r.min + r.max) / 2;

let result;
if (weekly === null) {
  result = { version: FORMULA_VERSION, weeklyManualHours: null, automatablePct, hoursYear: null, workdays: null, fte: null,
    hourlyCost, currency, breakdown: null, moneyYear: null, monthlyCost: null, paybackWeeks: null,
    potential: a.repetition === 'varies' ? 'starter' : 'medium' };
} else {
  const P = new Set(pains);
  const taskYear = weekly * WORK_WEEKS;
  const reworkYear = P.has('errors') ? taskYear * REWORK_SHARE : 0;
  const coordinationYear = a.people !== '1' ? taskYear * COORDINATION_SHARE : 0;
  const totalYear = taskYear + reworkYear + coordinationYear;
  const hoursYear = { min: Math.round(totalYear * share.min), max: Math.round(totalYear * share.max) };
  const hoursMid = mid(hoursYear);
  const surcharge = P.has('overtime') ? OVERTIME_SURCHARGE[a.country] : 0;
  const money = (x) => Math.round((taskYear + reworkYear) * x * hourlyCost.usd
    + coordinationYear * x * hourlyCost.usd * LEAD_COST_FACTOR + taskYear * OVERTIME_SHARE * x * hourlyCost.usd * surcharge);
  const moneyYear = { min: money(share.min), max: money(share.max) };
  const weeklySavings = mid(moneyYear) / WORK_WEEKS;
  result = { version: FORMULA_VERSION, weeklyManualHours: Math.round((totalYear / WORK_WEEKS) * 10) / 10, automatablePct, hoursYear,
    workdays: Math.round(hoursMid / HOURS_PER_WORKDAY), fte: Math.round((hoursMid / HOURS_PER_FTE_YEAR) * 10) / 10,
    hourlyCost, currency,
    breakdown: { taskHoursYear: Math.round(taskYear), reworkHoursYear: Math.round(reworkYear), coordinationHoursYear: Math.round(coordinationYear),
      employerLoad: load, overtimeSurchargePct: surcharge ? Math.round(surcharge * 100) : null },
    moneyYear, monthlyCost: Math.round(mid(moneyYear) / 12),
    paybackWeeks: weeklySavings > 0 ? Math.max(1, Math.ceil(PILOT_USD / weeklySavings)) : null,
    potential: hoursMid >= POTENTIAL_HIGH ? 'high' : hoursMid >= POTENTIAL_MEDIUM ? 'medium' : 'starter' };
}

// ---- qualification.ts (v2): interna, nunca se muestra al cliente
const TIMELINE_POINTS = { 'this-month': 3, '1-3-months': 2, exploring: 0 };
const ROLE_POINTS = { owner: 2, finance: 2, sales: 1, ops: 1, other: 0 };
const SIZE_POINTS = { '1-10': 1, '11-50': 2, '51-200': 2, '200+': 2 };
const volumePoints = weekly === null ? 1 : weekly >= 20 ? 3 : weekly >= 10 ? 2 : weekly >= 5 ? 1 : 0;
const score = volumePoints + TIMELINE_POINTS[a.timeline] + Math.min(3, pains.length) + SIZE_POINTS[a.companySize]
  + ROLE_POINTS[a.role] + (['co', 'latam', 'us', 'es'].includes(a.country) ? 1 : 0) + (tools.some(t => t !== 'paper') ? 1 : 0);
let qualification = score >= 10 ? 'encaja' : score >= 5 ? 'dudoso' : 'no_califica';
let qualificationReason = null;
if (['health', 'restricted'].includes(a.sector)) { qualification = 'no_califica'; qualificationReason = 'sector restringido'; }

// ---- textos (messages/es.json del website)
const L = {
  areas: { 'a-medida': 'Flujos a medida', contenido: 'Marketing con IA', comunicaciones: 'Comunicaciones y ventas',
    operaciones: 'Operaciones y finanzas', diseno: 'Diseño gráfico y video', web: 'Optimización web' },
  people: { '1': 'Solo yo', '2-3': '2-3', '4-10': '4-10', '10+': 'Más de 10' },
  hours: { lt2: 'Menos de 2 h', '2-5': '2-5 h', '5-10': '5-10 h', '10+': 'Más de 10 h', unknown: 'No lo sé' },
  repetition: { always: 'Sí, siempre igual', mostly: 'Casi siempre, con algunas excepciones', varies: 'Cambia bastante cada vez' },
  tools: { sheets: 'Excel / Google Sheets', whatsapp: 'WhatsApp', email: 'Correo (Gmail / Outlook)', crm: 'CRM',
    erp: 'ERP o contable', einvoice: 'Facturación electrónica', nocode: 'Zapier / Make / n8n', paper: 'Papel o nada digital', other: 'Otra' },
  pains: { errors: 'Se cometen errores que hay que corregir', waiting: 'Los clientes o el equipo se quedan esperando',
    overtime: 'Toca hacer horas extra', hiring: 'Tendríamos que contratar a alguien más' },
  sector: { retail: 'Comercio y retail', services: 'Servicios profesionales', manufacturing: 'Manufactura y logística',
    education: 'Educación', tech: 'Tecnología', health: 'Salud o datos médicos', restricted: 'Apuestas, cripto o adultos', other: 'Otro' },
  companySize: { '1-10': '1-10', '11-50': '11-50', '51-200': '51-200', '200+': 'Más de 200' },
  country: { co: 'Colombia', latam: 'Resto de Latinoamérica', us: 'EE. UU.', es: 'España', other: 'Otro' },
  role: { owner: 'Dueño o gerente general', finance: 'Finanzas', sales: 'Comercial o marketing', ops: 'Operaciones o TI', other: 'Otro' },
  timeline: { 'this-month': 'Lo antes posible, este mes', '1-3-months': 'En 1 a 3 meses', exploring: 'Por ahora solo estoy explorando' },
  investment: { lt500: 'Menos de US$500', '500-1500': 'US$500-1.500', '1500-5000': 'US$1.500-5.000', '5000+': 'Más de US$5.000', unknown: 'Aún no lo sé' },
};
const POTENTIAL = { high: 'Alto', medium: 'Medio', starter: 'Inicial' };
const POTENTIAL_TEXT = { high: 'Tu proceso es un gran candidato: se repite mucho y consume muchas horas.',
  medium: 'Hay un ahorro claro y un buen punto de partida para un primer piloto.',
  starter: 'Es un buen punto de partida: empezar por algo pequeño da resultados rápidos.' };
const EFFECTS = { errors: 'Menos errores: los datos pasan solos de un sistema a otro, sin digitar.',
  waiting: 'Respuestas al instante: nadie se queda esperando a que alguien tenga tiempo.',
  overtime: 'Sin horas extra para ponerse al día con tareas repetitivas.',
  hiring: 'Creces sin contratar a alguien solo para tareas manuales.',
  default: 'Tu equipo dedica ese tiempo a vender, atender y hacer crecer el negocio.' };
const PROCESS_EXAMPLES = {
  'a-medida': ['Pasar datos entre sistemas', 'Aprobaciones internas', 'Reportes a la medida'],
  contenido: ['Escribir posts para redes', 'Armar el newsletter', 'Fichas de producto'],
  comunicaciones: ['Responder mensajes de WhatsApp', 'Registrar leads en el CRM', 'Seguimiento de cotizaciones'],
  operaciones: ['Digitar facturas de proveedores', 'Conciliar pagos', 'Reportes manuales'],
  diseno: ['Piezas para redes', 'Editar videos cortos', 'Adaptar diseños a formatos'],
  web: ['Actualizar contenido del sitio', 'Revisar SEO y velocidad', 'Atender formularios del sitio'] };

// ---- suggestions.ts
const lists = areas.map(x => PROCESS_EXAMPLES[x] || []);
const examples = [];
for (let i = 0; examples.length < 4 && lists.some(l => i < l.length); i++)
  for (const l of lists) if (l[i] && examples.length < 4 && !examples.includes(l[i])) examples.push(l[i]);
const named = (a.process || '').trim();
const suggestions = (named ? [named, ...examples.filter(e => e !== named)] : examples).slice(0, 3);

// ---- formato
const thousands = (n) => String(Math.round(n)).replace(/\B(?=(\d{3})+(?!\d))/g, '.');
const money = (usd) => currency.code === 'COP' ? '$' + thousands(Math.round((usd * currency.perUsd) / 1000) * 1000) : 'US$' + thousands(usd);
const pot = POTENTIAL[result.potential];
const lines = ['📊 *Tu diagnóstico de automatización*', a.name ? '_Preparado para ' + a.name + '_' : null, ''];
if (result.hoursYear) {
  lines.push('Podrías recuperar *' + thousands(result.hoursYear.min) + '–' + thousands(result.hoursYear.max) + ' h al año*');
  lines.push('💰 Ahorro estimado: *' + money(result.moneyYear.min) + ' – ' + money(result.moneyYear.max) + '* al año', '');
  lines.push('• Potencial: *' + pot + '*');
  lines.push('• Automatizable: *' + automatablePct.min + '–' + automatablePct.max + ' %* de la tarea');
  lines.push('• Hoy te cuesta cerca de *' + money(result.monthlyCost) + '* al mes');
  if (result.paybackWeeks) lines.push('• Un piloto se pagaría en *~' + result.paybackWeeks + (result.paybackWeeks === 1 ? ' semana*' : ' semanas*'));
} else {
  lines.push('Tu proceso tiene potencial *' + pot + '* y entre el *' + automatablePct.min + ' y ' + automatablePct.max + ' %* se puede automatizar.', '');
  lines.push('_Como no tenías claras las horas, aún no ponemos cifras: con un asesor las medimos contigo._');
}
lines.push('', '_' + POTENTIAL_TEXT[result.potential] + '_');
if (suggestions.length) { lines.push('', '*Por dónde empezaríamos*'); suggestions.forEach((s, i) => lines.push((i + 1) + '. ' + s)); }
const effects = pains.filter(p => EFFECTS[p]).slice(0, 2).map(p => EFFECTS[p]);
lines.push('', '*Lo que cambiaría*'); (effects.length ? effects : [EFFECTS.default]).forEach(e => lines.push('• ' + e));
lines.push('', '_Es una estimación orientativa: la validamos contigo con tu proceso real._');
const report = lines.filter(l => l !== null).join('\n').slice(0, 4000);

const now = DateTime.now().setZone('America/Bogota');
const diagnosisId = 'DIAG-WA-' + now.toFormat('yyyyMMdd') + '-' + String(step.diagnosis_row_id).padStart(4, '0');
const headline = result.hoursYear
  ? 'Potencial ' + pot + ' · ' + thousands(result.hoursYear.min) + '–' + thousands(result.hoursYear.max) + ' h/año · ' + money(result.moneyYear.min) + '–' + money(result.moneyYear.max) + '/año'
  : 'Potencial ' + pot + ' · ' + automatablePct.min + '–' + automatablePct.max + ' % automatizable (sin horas)';

return [{ json: {
  result, score, qualification, qualificationReason, report, diagnosisId, headline, suggestions,
  labels: {
    areas: areas.map(x => L.areas[x] || x).join(', '), process: named, people: L.people[a.people], hours: L.hours[a.hours],
    repetition: L.repetition[a.repetition], tools: tools.map(t => L.tools[t] || t).join(', '), pains: pains.map(p => L.pains[p]).join('; '),
    sector: L.sector[a.sector], companySize: L.companySize[a.companySize], country: L.country[a.country], role: L.role[a.role],
    timeline: L.timeline[a.timeline], investment: L.investment[a.investment] },
  name: a.name || '', email: a.email || '', now: now.toFormat('yyyy-MM-dd HH:mm'), today: now.toFormat('yyyyMMdd'),
} }];`;

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
  'País': c.labels.country, 'Sector': c.labels.sector, 'Tamaño': c.labels.companySize, 'Cargo': c.labels.role,
  'Presupuesto': c.labels.investment, 'Plazo': c.labels.timeline, 'Áreas': c.labels.areas,
  'Horas manuales/semana': r.weeklyManualHours ?? '',
  'Ahorro anual estimado (US$)': r.moneyYear ? r.moneyYear.min + '–' + r.moneyYear.max : '',
  'Calificación': c.qualification + (c.qualificationReason ? ' (' + c.qualificationReason + ')' : ''),
  'Reporte': c.headline + (c.labels.process ? ' · Tarea: ' + c.labels.process : ''),
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
  '👤 <b>Nombre:</b> ' + ${esc(`${CALC}.name`)},
  '📱 <b>WhatsApp:</b> +' + ${STEP}.wa_id + (${CALC}.email ? '  ·  ✉️ ' + ${esc(`${CALC}.email`)} : ''),
  '🏷️ <b>Calificación:</b> ' + ${QUAL} + ' (' + ${CALC}.score + ' pts' + (${CALC}.qualificationReason ? ', ' + ${CALC}.qualificationReason : '') + ')',
  '⚡ <b>Resultado:</b> ' + ${esc(`${CALC}.headline`)},
  '',
  '🧩 <b>Áreas:</b> ' + ${esc(`${CALC}.labels.areas`)},
  '📝 <b>Tarea:</b> ' + ${esc(`${CALC}.labels.process || 'No indicó'`)},
  '👥 ' + ${CALC}.labels.people + ' persona(s) · ' + ${CALC}.labels.hours + '/semana c/u · ' + ${esc(`${CALC}.labels.repetition`)},
  '🛠️ <b>Herramientas:</b> ' + ${esc(`${CALC}.labels.tools`)},
  '⚠️ <b>Cuando se atrasa:</b> ' + ${esc(`${CALC}.labels.pains || 'Nada en particular'`)},
  '',
  '🏢 ' + ${esc(`${CALC}.labels.sector`)} + ' · ' + ${CALC}.labels.companySize + ' personas · ' + ${esc(`${CALC}.labels.country`)},
  '🎯 <b>Cargo:</b> ' + ${esc(`${CALC}.labels.role`)},
  '⏱️ <b>Plazo:</b> ' + ${esc(`${CALC}.labels.timeline`)} + '  ·  💵 ' + ${esc(`${CALC}.labels.investment`)},
  '🆔 ' + ${CALC}.diagnosisId + ' · Lead ' + ${ROWS}.leadId + (${ROWS}.isNew ? ' (nuevo)' : '')
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
    graph('g10', 'Enviar reporte', [1760, 200],
      `{ messaging_product: 'whatsapp', recipient_type: 'individual', to: ${STEP}.wa_id, type: 'text', text: { preview_url: false, body: $json.report } }`),
    graph('g11', 'Enviar siguientes pasos', [1980, 200],
      `{ messaging_product: 'whatsapp', recipient_type: 'individual', to: ${STEP}.wa_id, type: 'interactive', interactive: { type: 'button', body: { text: '¿Cómo quieres seguir?\\n\\n_Las dos opciones son gratis y sin compromiso._' }, action: { buttons: [ { type: 'reply', reply: { id: 'asesor', title: '${NEXT_BUTTONS[0]}' } }, { type: 'reply', reply: { id: 'ejemplos', title: '${NEXT_BUTTONS[1]}' } } ] } } }`),
    pg('g12', 'Registrar reporte (SQL)', [2200, 200],
      "SELECT (SELECT message_id FROM chatbot.register_outbound(jsonb_build_object('wamid', $1, 'wa_id', $3, 'type', 'text', 'text', $4))) AS report_msg,\n       (SELECT message_id FROM chatbot.register_outbound(jsonb_build_object('wamid', $2, 'wa_id', $3, 'type', 'interactive',\n          'text', '¿Cómo quieres seguir?', 'agent_text', '¿Cómo quieres seguir? [Botones: " + NEXT_BUTTONS.join(' | ') + "]'))) AS buttons_msg",
      `={{ [ $('Enviar reporte').first().json.messages[0].id, $json.messages[0].id, ${STEP}.wa_id, ${CALC}.report ] }}`),
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
      parameters: { width: 960, height: 320, content: '## FLOW · Diagnóstico\nEntradas: `wa_id`, `text`, `action` (`start` | `continue`).\n1. `chatbot.diagnosis_step`: mismas 14 preguntas del diagnóstico del website (+ nombre si no lo conocemos y correo opcional), con botones / listas; selección múltiple con *Agregar otra* / *Continuar*. *cancelar* lo detiene; se puede retomar dentro de 24 h.\n2. Al terminar, **Calcular diagnóstico** replica la fórmula v2 del website (`lib/assessment/report.ts`), la calificación interna (`qualification.ts`) y las sugerencias. Si cambian en el website, actualizar aquí (`scripts/diagnosis-workflow.mjs`).\n3. Envía el reporte + botones *Hablar con un asesor* / *Ver ejemplos* → Sheet: **Leads** (crea o actualiza; Etapa *Diagnosticado*, Diagnóstico ID) y **Diagnósticos** (nueva fila, Canal WhatsApp) → aviso en Telegram con la calificación.' } },
  ],
  connections: connect([
    ['Entrada', 'Paso (SQL)'], ['Paso (SQL)', '¿Hay mensajes?'], ['¿Hay mensajes?', 'Un item por mensaje', 0], ['¿Hay mensajes?', 'Respuesta: sin diagnóstico', 1], ['Un item por mensaje', 'Enviar mensaje'],
    ['Enviar mensaje', 'Registrar mensaje (SQL)'], ['Registrar mensaje (SQL)', 'Una vez'], ['Una vez', '¿Diagnóstico completo?'],
    ['¿Diagnóstico completo?', 'Calcular diagnóstico', 0], ['¿Diagnóstico completo?', 'Respuesta: paso enviado', 1],
    ['Calcular diagnóstico', 'Enviar reporte'], ['Enviar reporte', 'Enviar siguientes pasos'], ['Enviar siguientes pasos', 'Registrar reporte (SQL)'],
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
