#!/usr/bin/env node
// ==========================================
// Sincroniza workflows entre n8n (API pública) y la carpeta workflows/
//
//   node scripts/n8n-sync.mjs pull            # n8n  -> workflows/*.json
//   node scripts/n8n-sync.mjs push [archivo]  # workflows/*.json -> n8n (crea o actualiza por id)
//   node scripts/n8n-sync.mjs list            # lista workflows en n8n
//   ... --remote                              # contra el servidor (n8n.automaverso.com)
//
// Local:  N8N_API_URL, N8N_API_KEY
// Remoto: N8N_REMOTE_API_URL, N8N_REMOTE_API_KEY, CF_ACCESS_CLIENT_ID, CF_ACCESS_CLIENT_SECRET
// Todo se lee de .env (o del entorno).
// Las credenciales NO viajan: los workflows solo guardan referencias a ellas.
// ==========================================
import { readFileSync, writeFileSync, readdirSync, existsSync } from 'node:fs';
import { join, dirname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const WF_DIR = join(ROOT, 'workflows');

function loadEnv() {
  const envPath = join(ROOT, '.env');
  const env = {};
  if (existsSync(envPath)) {
    for (const line of readFileSync(envPath, 'utf8').split(/\r?\n/)) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
      if (m) env[m[1]] = m[2].replace(/^["']|["']$/g, '');
    }
  }
  return { ...env, ...process.env };
}

const env = loadEnv();
const argv = process.argv.slice(2);
const REMOTE = argv.includes('--remote');
const BASE = (REMOTE ? env.N8N_REMOTE_API_URL : env.N8N_API_URL || 'http://localhost:5678').replace(/\/+$/, '');
const KEY = REMOTE ? env.N8N_REMOTE_API_KEY : env.N8N_API_KEY;
if (!BASE || !KEY) {
  console.error(REMOTE ? 'Faltan N8N_REMOTE_API_URL / N8N_REMOTE_API_KEY en .env' : 'Falta N8N_API_KEY en .env');
  process.exit(1);
}
// Cloudflare Access (service token) para la instancia remota
const CF_HEADERS =
  REMOTE && env.CF_ACCESS_CLIENT_ID
    ? { 'CF-Access-Client-Id': env.CF_ACCESS_CLIENT_ID, 'CF-Access-Client-Secret': env.CF_ACCESS_CLIENT_SECRET }
    : {};
console.error(`→ ${REMOTE ? 'REMOTO' : 'local'}: ${BASE}`);

async function api(method, path, body) {
  const res = await fetch(`${BASE}/api/v1${path}`, {
    method,
    redirect: 'manual',
    headers: { ...CF_HEADERS, 'X-N8N-API-KEY': KEY, 'Content-Type': 'application/json', Accept: 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${method} ${path} -> HTTP ${res.status}: ${text.slice(0, 300)}`);
  return text ? JSON.parse(text) : null;
}

async function listAll() {
  const out = [];
  let cursor;
  do {
    const q = new URLSearchParams({ limit: '100', ...(cursor ? { cursor } : {}) });
    const page = await api('GET', `/workflows?${q}`);
    out.push(...page.data);
    cursor = page.nextCursor;
  } while (cursor);
  return out;
}

const safeName = (name) => name.replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').trim() || 'workflow';

// Campos que acepta la API pública al crear/actualizar
const SETTINGS_KEYS = [
  'saveExecutionProgress', 'saveManualExecutions', 'saveDataErrorExecution',
  'saveDataSuccessExecution', 'executionTimeout', 'errorWorkflow', 'timezone',
  'executionOrder', 'callerPolicy', 'callerIds', 'timeSavedPerExecution',
];
function toPayload(wf) {
  const settings = Object.fromEntries(
    Object.entries(wf.settings || {}).filter(([k]) => SETTINGS_KEYS.includes(k)),
  );
  return {
    name: wf.name,
    nodes: wf.nodes,
    connections: wf.connections || {},
    settings: { executionOrder: 'v1', ...settings },
    ...(wf.staticData ? { staticData: wf.staticData } : {}),
  };
}

async function pull() {
  const list = await listAll();
  for (const item of list) {
    const wf = await api('GET', `/workflows/${item.id}`);
    const { id, name, active, nodes, connections, settings, pinData, staticData, tags } = wf;
    const file = join(WF_DIR, `${safeName(name)}.json`);
    writeFileSync(
      file,
      JSON.stringify({ id, name, active, nodes, connections, settings, pinData, staticData, tags }, null, 2) + '\n',
    );
    console.log(`↓ ${name}  (${id})  -> workflows/${basename(file)}`);
  }
  console.log(`${list.length} workflow(s) exportados.`);
}

async function push(only) {
  const files = only
    ? [only.includes('/') || only.includes('\\') ? only : join(WF_DIR, only)]
    : readdirSync(WF_DIR).filter((f) => f.endsWith('.json')).map((f) => join(WF_DIR, f));
  const remoteIds = new Set((await listAll()).map((w) => w.id));

  for (const file of files) {
    const wf = JSON.parse(readFileSync(file, 'utf8'));
    const payload = toPayload(wf);
    if (wf.id && remoteIds.has(wf.id)) {
      await api('PUT', `/workflows/${wf.id}`, payload);
      console.log(`↑ actualizado ${wf.name} (${wf.id})`);
    } else {
      const created = await api('POST', '/workflows', payload);
      // Guardar el nuevo id para que el siguiente push actualice en vez de duplicar
      wf.id = created.id;
      writeFileSync(file, JSON.stringify(wf, null, 2) + '\n');
      console.log(`↑ creado ${wf.name} (${created.id})`);
    }
  }
  console.log('Listo. Recuerda: en n8n 2.x los cambios no están en producción hasta publicar el workflow.');
}

async function list() {
  for (const w of await listAll()) console.log(`${w.active ? '●' : '○'} ${w.id}  ${w.name}`);
}

const [cmd, arg] = argv.filter((a) => a !== '--remote');
const actions = { pull, push: () => push(arg), list };
if (!actions[cmd]) {
  console.log('Uso: node scripts/n8n-sync.mjs <pull|push [archivo]|list> [--remote]');
  process.exit(1);
}
actions[cmd]().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
