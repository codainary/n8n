#!/usr/bin/env node
// ==========================================
// Estructura del Sheet «Automaverso · Leads» (hojas Leads + Diagnósticos).
// Reorganiza columnas, formatos, listas desplegables, colores de Etapa, filtro y bandas.
// SOLO para un Sheet sin datos (aborta si encuentra filas con datos).
//
//   GOOGLE_TOKEN=$(gcloud auth print-access-token --account=hello@automaverso.com) node scripts/leads-sheet-setup.mjs
// Diccionario de columnas: docs/leads-sheet.md
// ==========================================
const SHEET_ID = '1huKPPW_kkbLVsw6jSpMXUgD74I9o5Jvk8v6N9_kHXcA';
const T = process.env.GOOGLE_TOKEN;
if (!T) { console.error('Falta GOOGLE_TOKEN'); process.exit(1); }

const rgb = (r, g, b) => ({ red: r, green: g, blue: b });
const C = {
  ink: rgb(0.098, 0.094, 0.078), muted: rgb(0.42, 0.4, 0.361), paper: rgb(0.984, 0.98, 0.965),
  orange: rgb(0.886, 0.337, 0.043), teal: rgb(0.043, 0.42, 0.388), line: rgb(0.886, 0.867, 0.824), white: rgb(1, 1, 1),
};
const STYLES = {
  mono: { textFormat: { fontFamily: 'JetBrains Mono', fontSize: 9, foregroundColor: C.muted } },
  text: { textFormat: { fontFamily: 'Inter', fontSize: 10, foregroundColor: C.ink } },
  name: { textFormat: { fontFamily: 'Inter', fontSize: 10, bold: true, foregroundColor: C.ink } },
  link: { textFormat: { fontFamily: 'Inter', fontSize: 10, foregroundColor: C.teal } },
  center: { horizontalAlignment: 'CENTER', textFormat: { fontFamily: 'Inter', fontSize: 10, foregroundColor: C.ink } },
  right: { horizontalAlignment: 'RIGHT', textFormat: { fontFamily: 'Inter', fontSize: 10, foregroundColor: C.ink } },
};
const BASE_CELL = { borders: { bottom: { style: 'SOLID', width: 1, color: C.line } },
  padding: { top: 4, right: 8, bottom: 4, left: 8 }, verticalAlignment: 'MIDDLE', wrapStrategy: 'CLIP' };
const HEADER = { backgroundColor: C.ink, borders: { bottom: { style: 'SOLID_THICK', width: 3, color: C.orange } },
  padding: { top: 8, right: 8, bottom: 8, left: 8 }, verticalAlignment: 'MIDDLE', wrapStrategy: 'WRAP',
  textFormat: { foregroundColor: C.paper, fontFamily: 'JetBrains Mono', fontSize: 9, bold: true } };

export const ETAPAS = ['Contacto solicitado', 'Diagnosticado'];
export const MEDIOS = ['Chat de WhatsApp', 'Llamada por WhatsApp', 'Llamada al celular', 'Correo'];
export const CANALES = ['Website', 'WhatsApp'];

// [encabezado, estilo, ancho, lista desplegable]
const LEADS = [
  ['Lead ID', 'mono', 190], ['Etapa', 'center', 170, ETAPAS], ['Nombre o empresa', 'name', 230],
  ['WhatsApp / teléfono', 'mono', 160], ['Medio de contacto', 'text', 180, MEDIOS], ['Correo', 'text', 230],
  ['Diagnóstico ID', 'mono', 190],
  ['Resumen conversación (WhatsApp)', 'text', 340],
  ['Canal de entrada', 'center', 130, CANALES], ['Origen (UTM)', 'text', 180], ['Creado', 'mono', 150], ['Actualizado', 'mono', 150],
];
const DIAG = [
  ['Diagnóstico ID', 'mono', 190], ['Lead ID', 'mono', 190], ['Fecha', 'mono', 150], ['Canal', 'center', 120, CANALES], ['Idioma', 'mono', 80],
  ['País', 'text', 110], ['Sector', 'text', 190], ['Tamaño', 'text', 110], ['Cargo', 'text', 170], ['Presupuesto', 'text', 170], ['Plazo', 'text', 170], ['Áreas', 'text', 230],
  ['Horas manuales/semana', 'right', 160], ['Ahorro anual estimado (US$)', 'right', 200], ['Calificación', 'center', 140],
  ['Reporte', 'link', 260],
];
const ETAPA_COLORS = {
  'Contacto solicitado': [rgb(0.886, 0.925, 0.988), rgb(0.118, 0.306, 0.663)],
  Diagnosticado: [rgb(0.988, 0.906, 0.851), rgb(0.69, 0.259, 0.039)],
};
const ROWS = 1000;

async function api(method, path, body) {
  const r = await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${SHEET_ID}${path}`, {
    method, headers: { Authorization: `Bearer ${T}`, 'Content-Type': 'application/json' }, body: body && JSON.stringify(body) });
  const j = await r.json();
  if (!r.ok) throw new Error(JSON.stringify(j).slice(0, 600));
  return j;
}

const meta = await api('GET', '?fields=sheets(properties,conditionalFormats,bandedRanges,basicFilter)');
const sheetOf = (t) => meta.sheets.find((s) => s.properties.title === t);
for (const t of ['Leads', 'Diagnósticos']) {
  if (!sheetOf(t)) continue;
  const v = await api('GET', `/values/${encodeURIComponent(`'${t}'!A2:Z`)}`);
  if ((v.values || []).some((row) => row.some((c) => String(c).trim() !== ''))) {
    console.error(`La hoja «${t}» ya tiene datos: no se reorganiza.`); process.exit(1);
  }
}

// Prepara una hoja: limpia reglas, ajusta tamaño, encabezados, formatos, anchos, listas, filtro y bandas.
function layout(sheet, cols, opts) {
  const id = sheet.properties.sheetId, n = cols.length, req = [];
  for (const b of sheet.bandedRanges || []) req.push({ deleteBanding: { bandedRangeId: b.bandedRangeId } });
  if (sheet.basicFilter) req.push({ clearBasicFilter: { sheetId: id } });
  (sheet.conditionalFormats || []).forEach(() => req.push({ deleteConditionalFormatRule: { sheetId: id, index: 0 } }));
  const curCols = sheet.properties.gridProperties.columnCount, curRows = sheet.properties.gridProperties.rowCount;
  req.push({ updateSheetProperties: { properties: { sheetId: id, title: opts.title, index: opts.index,
    tabColor: opts.tab, gridProperties: { rowCount: Math.max(curRows, ROWS), columnCount: Math.max(curCols, n),
      frozenRowCount: 1, frozenColumnCount: opts.frozen, hideGridlines: true } },
    fields: 'title,index,tabColor,gridProperties(rowCount,columnCount,frozenRowCount,frozenColumnCount,hideGridlines)' } });
  if (curCols > n) req.push({ deleteDimension: { range: { sheetId: id, dimension: 'COLUMNS', startIndex: n, endIndex: curCols } } });
  const all = { sheetId: id, startRowIndex: 0, endRowIndex: ROWS, startColumnIndex: 0, endColumnIndex: n };
  req.push({ updateCells: { range: all, fields: 'userEnteredValue,userEnteredFormat,dataValidation,note' } });
  req.push({ updateCells: { range: { ...all, endRowIndex: 1 }, fields: 'userEnteredValue,userEnteredFormat',
    rows: [{ values: cols.map(([h]) => ({ userEnteredValue: { stringValue: h }, userEnteredFormat: HEADER })) }] } });
  cols.forEach(([, style, width, list], i) => {
    const colRange = { sheetId: id, startColumnIndex: i, endColumnIndex: i + 1 };
    req.push({ repeatCell: { range: { ...colRange, startRowIndex: 1, endRowIndex: ROWS },
      cell: { userEnteredFormat: { ...BASE_CELL, ...STYLES[style] } }, fields: 'userEnteredFormat' } });
    req.push({ updateDimensionProperties: { range: { sheetId: id, dimension: 'COLUMNS', startIndex: i, endIndex: i + 1 },
      properties: { pixelSize: width }, fields: 'pixelSize' } });
    if (list) req.push({ setDataValidation: { range: { ...colRange, startRowIndex: 1, endRowIndex: ROWS }, rule: {
      condition: { type: 'ONE_OF_LIST', values: list.map((v) => ({ userEnteredValue: v })) }, showCustomUi: true, strict: false } } });
  });
  req.push({ updateDimensionProperties: { range: { sheetId: id, dimension: 'ROWS', startIndex: 0, endIndex: 1 }, properties: { pixelSize: 44 }, fields: 'pixelSize' } });
  req.push({ updateDimensionProperties: { range: { sheetId: id, dimension: 'ROWS', startIndex: 1, endIndex: ROWS }, properties: { pixelSize: 30 }, fields: 'pixelSize' } });
  req.push({ addBanding: { bandedRange: { range: { ...all, startRowIndex: 1 },
    rowProperties: { firstBandColor: C.white, secondBandColor: C.paper } } } });
  req.push({ setBasicFilter: { filter: { range: all } } });
  return req;
}

const req = [];
let leads = sheetOf('Leads');
req.push(...layout(leads, LEADS, { title: 'Leads', index: 0, frozen: 0, tab: C.orange }));
const etapaCol = LEADS.findIndex(([h]) => h === 'Etapa');
for (const [value, [bg, fg]] of Object.entries(ETAPA_COLORS)) {
  req.push({ addConditionalFormatRule: { index: 0, rule: {
    ranges: [{ sheetId: leads.properties.sheetId, startRowIndex: 1, endRowIndex: ROWS, startColumnIndex: etapaCol, endColumnIndex: etapaCol + 1 }],
    booleanRule: { condition: { type: 'TEXT_EQ', values: [{ userEnteredValue: value }] },
      format: { backgroundColor: bg, textFormat: { foregroundColor: fg, bold: true } } } } } });
}

let diag = sheetOf('Diagnósticos');
if (!diag) {
  const added = await api('POST', ':batchUpdate', { requests: [{ addSheet: { properties: { title: 'Diagnósticos', index: 1,
    gridProperties: { rowCount: ROWS, columnCount: DIAG.length } } } }] });
  diag = { properties: added.replies[0].addSheet.properties };
}
req.push(...layout(diag, DIAG, { title: 'Diagnósticos', index: 1, frozen: 1, tab: C.teal }));

await api('POST', ':batchUpdate', { requests: req });
const check = await api('GET', `/values:batchGet?ranges=${encodeURIComponent('Leads!1:1')}&ranges=${encodeURIComponent("'Diagnósticos'!1:1")}`);
for (const vr of check.valueRanges) console.log(vr.range, '→', vr.values[0].join(' | '));
