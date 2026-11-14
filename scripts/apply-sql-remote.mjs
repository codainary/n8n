#!/usr/bin/env node
// ==========================================
// Aplica un archivo SQL al Postgres del VPS (n8n-db) a través de n8n.
// El Postgres no tiene puertos públicos: solo n8n lo alcanza. El script crea
// un workflow temporal (Webhook -> Postgres), lo ejecuta una vez, muestra el
// resultado y lo elimina.
//
//   node scripts/apply-sql-remote.mjs sql/001_chatbot_schema.sql
//   node scripts/apply-sql-remote.mjs consulta.sql --raw   # devuelve la salida del SQL (sin verificación)
//
// Requiere en .env: N8N_REMOTE_API_URL, N8N_REMOTE_API_KEY,
// CF_ACCESS_CLIENT_ID, CF_ACCESS_CLIENT_SECRET y la credencial de n8n
// "Postgres VPS (chatbot)" (id en PG_CREDENTIAL_ID o por defecto abajo).
// ==========================================
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const env = { ...Object.fromEntries(
  (existsSync(join(ROOT, '.env')) ? readFileSync(join(ROOT, '.env'), 'utf8') : '')
    .split(/\r?\n/).map((l) => l.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/)).filter(Boolean)
    .map((m) => [m[1], m[2].replace(/^["']|["']$/g, '')]),
), ...process.env };

const RAW = process.argv.includes('--raw');
const file = process.argv.slice(2).find((a) => a !== '--raw');
if (!file) { console.error('Uso: node scripts/apply-sql-remote.mjs <archivo.sql>'); process.exit(1); }
const sql = readFileSync(resolve(file), 'utf8');

const BASE = env.N8N_REMOTE_API_URL.replace(/\/+$/, '');
const CF = { 'CF-Access-Client-Id': env.CF_ACCESS_CLIENT_ID, 'CF-Access-Client-Secret': env.CF_ACCESS_CLIENT_SECRET };
const CRED_ID = env.PG_CREDENTIAL_ID || 'aV6poYyo4OBcJu8E';

async function api(method, path, body) {
  const res = await fetch(`${BASE}/api/v1${path}`, {
    method, redirect: 'manual',
    headers: { ...CF, 'X-N8N-API-KEY': env.N8N_REMOTE_API_KEY, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${method} ${path} -> ${res.status}: ${text.slice(0, 400)}`);
  return text ? JSON.parse(text) : null;
}

const path = `migrate-${randomUUID()}`;
const pg = { postgres: { id: CRED_ID, name: 'Postgres VPS (chatbot)' } };
const workflow = {
  name: `_migración temporal ${new Date().toISOString()}`,
  settings: { executionOrder: 'v1' },
  nodes: [
    { id: 'm1', name: 'Webhook', type: 'n8n-nodes-base.webhook', typeVersion: 2.2, position: [0, 0],
      webhookId: randomUUID(), parameters: { httpMethod: 'POST', path, responseMode: 'lastNode', options: {} } },
    { id: 'm2', name: 'Aplicar SQL', type: 'n8n-nodes-base.postgres', typeVersion: 2.7, position: [240, 0],
      credentials: pg, executeOnce: true,
      parameters: { operation: 'executeQuery', query: sql, options: {} } },
    { id: 'm3', name: 'Verificar', type: 'n8n-nodes-base.postgres', typeVersion: 2.7, position: [480, 0],
      credentials: pg, executeOnce: true,
      parameters: { operation: 'executeQuery', options: {}, query:
        "SELECT (SELECT string_agg(table_name, ',' ORDER BY table_name) FROM information_schema.tables WHERE table_schema='chatbot') AS tables, " +
        "(SELECT string_agg(DISTINCT routine_name, ',' ORDER BY routine_name) FROM information_schema.routines WHERE routine_schema='chatbot') AS functions, " +
        "current_database() AS db, version() AS pg" } },
  ],
  connections: {
    Webhook: { main: [[{ node: 'Aplicar SQL', type: 'main', index: 0 }]] },
    'Aplicar SQL': { main: [[{ node: 'Verificar', type: 'main', index: 0 }]] },
  },
};

if (RAW) {
  workflow.nodes = workflow.nodes.filter((n) => n.name !== 'Verificar');
  delete workflow.connections['Aplicar SQL'];
  workflow.nodes[1].executeOnce = false;
  workflow.nodes[0].parameters.responseMode = 'lastNode';
  workflow.nodes[0].parameters.responseData = 'allEntries';
}

let id;
try {
  id = (await api('POST', '/workflows', workflow)).id;
  await api('POST', `/workflows/${id}/activate`);
  await new Promise((r) => setTimeout(r, 1500));
  const res = await fetch(`${BASE}/webhook/${path}`, { method: 'POST', headers: CF });
  const body = await res.text();
  console.log(`HTTP ${res.status}`);
  console.log(body);
  if (!res.ok) process.exitCode = 1;
} catch (e) {
  console.error(e.message);
  process.exitCode = 1;
} finally {
  if (id) {
    await api('POST', `/workflows/${id}/deactivate`).catch(() => {});
    // n8n despublica de forma asíncrona: reintentar el borrado (el SQL puede contener secretos)
    let deleted = false;
    for (let i = 0; i < 10 && !deleted; i++) {
      try { await api('DELETE', `/workflows/${id}`); deleted = true; }
      catch { await new Promise((r) => setTimeout(r, 2000)); }
    }
    console.error(deleted ? `(workflow temporal ${id} eliminado)`
      : `⚠️  NO se pudo borrar el workflow temporal ${id}: bórralo a mano`);
    if (!deleted) process.exitCode = 1;
  }
}
