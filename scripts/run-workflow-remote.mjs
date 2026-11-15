#!/usr/bin/env node
// ==========================================
// Ejecuta ya un workflow del servidor que tenga «Execute Workflow Trigger»
// (p. ej. EX · 1 Sincronizar ejemplos) sin esperar su programación: crea un
// workflow temporal Webhook -> Execute Workflow, lo llama una vez y lo elimina.
//
//   node scripts/run-workflow-remote.mjs <workflowId>
// ==========================================
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const env = { ...Object.fromEntries(
  (existsSync(join(ROOT, '.env')) ? readFileSync(join(ROOT, '.env'), 'utf8') : '')
    .split(/\r?\n/).map((l) => l.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/)).filter(Boolean)
    .map((m) => [m[1], m[2].replace(/^["']|["']$/g, '')]),
), ...process.env };

const target = process.argv[2];
if (!target) { console.error('Uso: node scripts/run-workflow-remote.mjs <workflowId>'); process.exit(1); }
const BASE = env.N8N_REMOTE_API_URL.replace(/\/+$/, '');
const CF = { 'CF-Access-Client-Id': env.CF_ACCESS_CLIENT_ID, 'CF-Access-Client-Secret': env.CF_ACCESS_CLIENT_SECRET };

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

const path = `run-${randomUUID()}`;
const workflow = {
  name: `_ejecución temporal ${new Date().toISOString()}`,
  settings: { executionOrder: 'v1' },
  nodes: [
    { id: 'r1', name: 'Webhook', type: 'n8n-nodes-base.webhook', typeVersion: 2.2, position: [0, 0],
      webhookId: randomUUID(), parameters: { httpMethod: 'POST', path, responseMode: 'lastNode', responseData: 'allEntries', options: {} } },
    { id: 'r2', name: 'Ejecutar', type: 'n8n-nodes-base.executeWorkflow', typeVersion: 1.2, position: [240, 0],
      alwaysOutputData: true,
      parameters: { workflowId: { __rl: true, mode: 'id', value: target }, mode: 'once', options: { waitForSubWorkflow: true } } },
  ],
  connections: { Webhook: { main: [[{ node: 'Ejecutar', type: 'main', index: 0 }]] } },
};

let id;
try {
  id = (await api('POST', '/workflows', workflow)).id;
  await api('POST', `/workflows/${id}/activate`);
  await new Promise((r) => setTimeout(r, 1500));
  const res = await fetch(`${BASE}/webhook/${path}`, { method: 'POST', headers: CF });
  console.log(`HTTP ${res.status}`);
  console.log(await res.text());
  if (!res.ok) process.exitCode = 1;
} catch (e) {
  console.error(e.message);
  process.exitCode = 1;
} finally {
  if (id) {
    await api('POST', `/workflows/${id}/deactivate`).catch(() => {});
    let deleted = false;
    for (let i = 0; i < 10 && !deleted; i++) {
      try { await api('DELETE', `/workflows/${id}`); deleted = true; }
      catch { await new Promise((r) => setTimeout(r, 2000)); }
    }
    console.error(deleted ? `(workflow temporal ${id} eliminado)` : `⚠️  NO se pudo borrar el workflow temporal ${id}`);
  }
}
