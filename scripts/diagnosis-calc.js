// Código del nodo «Calcular diagnóstico» de FLOW · Diagnóstico (lo inserta scripts/diagnosis-workflow.mjs).
// Why Code: fórmula v2 del website (automaverso-web: lib/assessment/report.ts) con los rangos del diagnóstico
// rápido de WhatsApp (5 preguntas), calificación interna simplificada y armado del reporte.
const step = $('Paso (SQL)').first().json;
const a = step.answers;

// ---- país por el indicativo del WhatsApp (el diagnóstico rápido no lo pregunta)
const wa = String(step.wa_id || '');
const CARIBBEAN_NANP = /^1(809|829|849|787|939)/;   // R. Dominicana y Puerto Rico usan +1
const LATAM = ['52', '53', '54', '55', '56', '58', '51', '591', '593', '595', '598', '502', '503', '504', '505', '506', '507', '509'];
const country = wa.startsWith('57') ? 'co'
  : wa.startsWith('34') ? 'es'
  : CARIBBEAN_NANP.test(wa) || LATAM.some((p) => wa.startsWith(p)) ? 'latam'
  : wa.startsWith('1') ? 'us'
  : 'other';

// ---- referencias del website (options.ts) + rangos del diagnóstico rápido
const PEOPLE_MID = { '1': 1, '2-5': 3.5, '5+': 8 };
const HOURS_MID = { lt5: 2.5, '5-10': 7.5, '10+': 12 };
const REFERENCE_HOURLY_COST = { co: 6, latam: 7, us: 30, es: 18, other: 10 };   // US$/hora, salario base
const EMPLOYER_LOAD = { co: 1.52, latam: 1.4, us: 1.25, es: 1.32, other: 1.3 };   // prestaciones y aportes
const COP_PER_USD = 4000;
// ---- report.ts (v2)
const FORMULA_VERSION = 'v2-whatsapp', WORK_WEEKS = 46, HOURS_PER_WORKDAY = 8, PILOT_USD = 1000;
const REPETITION_SHARE = { always: 0.75, mostly: 0.6, varies: 0.4 };
const RANGE_LOW = 0.85, RANGE_HIGH = 1.1, MAX_SHARE = 0.85, COORDINATION_SHARE = 0.1, LEAD_COST_FACTOR = 1.5;
const POTENTIAL_HIGH = 500, POTENTIAL_MEDIUM = 150;

const weekly = PEOPLE_MID[a.people] * HOURS_MID[a.hours];
const A = REPETITION_SHARE[a.repetition];
const share = { min: A * RANGE_LOW, max: Math.min(MAX_SHARE, A * RANGE_HIGH) };
const automatablePct = { min: Math.round(share.min * 100), max: Math.round(share.max * 100) };
const hourlyUsd = Math.round(REFERENCE_HOURLY_COST[country] * EMPLOYER_LOAD[country] * 10) / 10;
const currency = country === 'co' ? { code: 'COP', perUsd: COP_PER_USD } : { code: 'USD', perUsd: 1 };
const taskYear = weekly * WORK_WEEKS;
const coordinationYear = a.people !== '1' ? taskYear * COORDINATION_SHARE : 0;   // un líder coordina al equipo
const totalYear = taskYear + coordinationYear;
const hoursYear = { min: Math.round(totalYear * share.min), max: Math.round(totalYear * share.max) };
const hoursMid = (hoursYear.min + hoursYear.max) / 2;
const money = (x) => Math.round(taskYear * x * hourlyUsd + coordinationYear * x * hourlyUsd * LEAD_COST_FACTOR);
const moneyYear = { min: money(share.min), max: money(share.max) };
const moneyMid = (moneyYear.min + moneyYear.max) / 2;
const weeklySavings = moneyMid / WORK_WEEKS;
const result = {
  version: FORMULA_VERSION, country, weeklyManualHours: Math.round((totalYear / WORK_WEEKS) * 10) / 10, automatablePct, hoursYear,
  workdays: Math.round(hoursMid / HOURS_PER_WORKDAY), hourlyCost: { usd: hourlyUsd, source: 'reference' }, currency,
  moneyYear, monthlyCost: Math.round(moneyMid / 12),
  paybackWeeks: weeklySavings > 0 ? Math.max(1, Math.ceil(PILOT_USD / weeklySavings)) : null,
  potential: hoursMid >= POTENTIAL_HIGH ? 'high' : hoursMid >= POTENTIAL_MEDIUM ? 'medium' : 'starter',
};

// ---- calificación interna simplificada (máx. 8): volumen 0-3 + plazo 0-3 + equipo 1 + tarea repetible 1
const volume = weekly >= 20 ? 3 : weekly >= 10 ? 2 : weekly >= 5 ? 1 : 0;
const score = volume + { 'this-month': 3, '1-3-months': 2, exploring: 0 }[a.timeline]
  + (a.people !== '1' ? 1 : 0) + (a.repetition !== 'varies' ? 1 : 0);
const qualification = score >= 6 ? 'encaja' : score >= 3 ? 'dudoso' : 'no_califica';

// ---- textos
const L = {
  area: { comunicaciones: 'Atención y ventas', operaciones: 'Operaciones y finanzas', contenido: 'Marketing y contenido' },
  people: { '1': 'Solo yo', '2-5': '2 a 5', '5+': 'Más de 5' },
  hours: { lt5: 'Menos de 5 h', '5-10': '5 a 10 h', '10+': 'Más de 10 h' },
  repetition: { always: 'Siempre igual', mostly: 'Casi siempre', varies: 'Cambia bastante' },
  timeline: { 'this-month': 'Lo antes posible, este mes', '1-3-months': 'En 1 a 3 meses', exploring: 'Por ahora solo estoy explorando' },
  country: { co: 'Colombia', latam: 'Resto de Latinoamérica', us: 'EE. UU.', es: 'España', other: 'Otro' },
};
const POTENTIAL = { high: 'Alto', medium: 'Medio', starter: 'Inicial' };
const EXAMPLES = {
  comunicaciones: ['Responder mensajes de WhatsApp', 'Registrar leads en el CRM', 'Seguimiento de cotizaciones'],
  operaciones: ['Digitar facturas de proveedores', 'Conciliar pagos', 'Reportes manuales'],
  contenido: ['Escribir posts para redes', 'Armar el newsletter', 'Fichas de producto'],
};

const thousands = (n) => String(Math.round(n)).replace(/\B(?=(\d{3})+(?!\d))/g, '.');
const fmt = (usd) => currency.code === 'COP'
  ? '$' + thousands(Math.round((usd * currency.perUsd) / 1000) * 1000)
  : 'US$' + thousands(usd);
const pot = POTENTIAL[result.potential];
const report = [
  '📊 *Tu diagnóstico rápido*',
  '',
  'Podrías recuperar *' + thousands(hoursYear.min) + '–' + thousands(hoursYear.max) + ' h al año*',
  '💰 Ahorro estimado: *' + fmt(moneyYear.min) + ' – ' + fmt(moneyYear.max) + '* al año',
  '',
  '• Potencial de automatización: *' + pot + '*',
  '• Se puede automatizar el *' + automatablePct.min + '–' + automatablePct.max + ' %* de esas tareas',
  ...(result.paybackWeeks ? ['• Un piloto se pagaría en *~' + result.paybackWeeks + (result.paybackWeeks === 1 ? ' semana*' : ' semanas*')] : []),
  '',
  '*Por dónde empezaríamos*',
  ...EXAMPLES[a.area].map((e, i) => (i + 1) + '. ' + e),
  '',
  '_Estimación orientativa con costos de referencia de ' + L.country[country] + '; un asesor la valida contigo._',
].join('\n');

const now = DateTime.now().setZone('America/Bogota');
const diagnosisId = 'DIAG-WA-' + now.toFormat('yyyyMMdd') + '-' + String(step.diagnosis_row_id).padStart(4, '0');
const headline = 'Potencial ' + pot + ' · ' + thousands(hoursYear.min) + '–' + thousands(hoursYear.max) + ' h/año · '
  + fmt(moneyYear.min) + '–' + fmt(moneyYear.max) + '/año';

return [{ json: {
  result, score, qualification, qualificationReason: null, report, diagnosisId, headline,
  labels: {
    area: L.area[a.area], people: L.people[a.people], hours: L.hours[a.hours], repetition: L.repetition[a.repetition],
    timeline: L.timeline[a.timeline], country: L.country[country],
  },
  name: a.name || '', now: now.toFormat('yyyy-MM-dd HH:mm'), today: now.toFormat('yyyyMMdd'),
} }];
