# n8n — entorno de trabajo

Desde aquí se diseñan, validan, despliegan y versionan workflows en dos instancias:

| Instancia | URL | Uso | MCP |
|---|---|---|---|
| **Servidor (principal)** | https://n8n.automaverso.com | Trabajo diario / producción | `n8n-mcp` |
| Local | http://localhost:5678 | Pruebas, upgrades (normalmente detenida) | `n8n-mcp-local` |

- El servidor está detrás de **Cloudflare Access**: toda petición necesita las cabeceras `CF-Access-Client-Id` / `CF-Access-Client-Secret` (service token en `.env`: `CF_ACCESS_CLIENT_ID`, `CF_ACCESS_CLIENT_SECRET`). Sin ellas responde 302 al login de Cloudflare. `n8n-mcp` las envía vía `N8N_CF_CLIENT_ID` / `N8N_CF_CLIENT_SECRET`.
- Por defecto se trabaja contra el **servidor**. Usar `n8n-mcp-local` solo si el usuario pide la instancia local.

## Chatbot de WhatsApp (en el servidor)

Documentación completa: **`docs/chatbot-whatsapp.md`** (arquitectura, esquema, workflows, seguridad, pruebas).

- Workflows: `WA · 1…5` (ingesta, procesamiento, enriquecimiento, mantenimiento, envío de documentos), `KB · 1…2` (Drive → Pinecone), `EX · 1` (videos de ejemplo Drive → Meta), `TOOL · …` (herramientas del agente), `FLOW · Contacto con asesor` (lead → Twenty + Telegram), `FLOW · Diagnóstico` (diagnóstico gratis por WhatsApp → Twenty + Telegram), `FLOW · Registrar en Twenty` (sub-workflow: persona + oportunidad en el CRM).
- Los leads van al CRM **Twenty** (crm.automaverso.com), ya no al Google Sheet. Generadores: `scripts/diagnosis-workflow.mjs`, `scripts/handoff-workflow.mjs`, `scripts/twenty-workflow.mjs` (escriben `workflows/*.json`; luego `push --remote` y publicar).
- Estado y lógica crítica en el Postgres del VPS, esquemas `chatbot` y `kb` (SQL versionado en `sql/`). Ese Postgres no tiene puertos públicos: aplicar/consultar SQL con `node scripts/apply-sql-remote.mjs <archivo.sql> [--raw]`.
- Secretos del bot (App Secret, verify token, etc.) en `chatbot.app_config`, nunca en workflows ni en git.
- **Convención de herramientas**: workflow `TOOL · <verbo> <objeto>` con entradas tipadas que devuelve `{ response }`, conectado al agente de `WA · 2` con «Call n8n Sub-Workflow Tool». El system prompt está en `scripts/phase2-agent.mjs`.
- Base de conocimiento: carpeta de Drive «Automaverso - Base de conocimiento del bot»; subcarpeta = namespace de Pinecone (`automaverso-kb`); lo que empieza por `_` se ignora.
- En n8n 2.x: un sub-workflow debe estar **publicado** antes de referenciarlo; para borrar un workflow, despublicarlo primero.
- Pruebas end-to-end sin celular: enviar webhooks firmados con HMAC (App Secret) a `/webhook/wa` desde números `000…` y leer las ejecuciones; limpiar los datos de prueba después.

La instancia local es self-hosted **n8n 2.47.7** en Docker, modo **queue** (lo que sigue describe su docker-compose).

## Arquitectura (docker-compose.yml)

| Servicio | Rol |
|---|---|
| `n8n-main` | UI, API pública, webhooks, MCP nativo — http://localhost:5678 |
| `n8n-worker-1/2` | Ejecutan los jobs de la cola (concurrencia 10 c/u) |
| `n8n-runner`, `n8n-worker-N-runner` | Task runners externos (`n8nio/runners`) para nodos Code JS/Python |
| `n8n-postgres` | Base de datos de n8n (volumen `postgres_data`) |
| `n8n-redis` | Cola Bull |

- `OFFLOAD_MANUAL_EXECUTIONS_TO_WORKERS=true`: también las ejecuciones manuales del editor van a los workers.
- Binary data en modo `database` (compartido entre main y workers).
- Las imágenes `n8nio/n8n` y `n8nio/runners` deben tener **siempre la misma versión** (anclas `x-n8n-image` / `x-runners-image`).

## Herramientas disponibles

- **MCP `n8n-mcp`** → servidor, **`n8n-mcp-local`** → local (alcance local; keys y token de Cloudflare viven en `~/.claude.json`, no en el repo): documentación de nodos, validación y CRUD de workflows.
- **MCP nativo de n8n** (`n8n-native`, si está configurado): ejecutar/buscar workflows expuestos desde Settings > Instance-level MCP.
- **Plugin `n8n-mcp-skills`**: skills de patrones, expresiones, nodos Code, validación, agentes IA, sub-workflows, manejo de errores.
- **`scripts/n8n-sync.mjs`**: sincroniza workflows entre n8n y `workflows/`.

## Flujo de trabajo

1. Buscar nodos y patrones con `n8n-mcp` y las skills antes de construir.
2. Construir/editar el workflow (vía `n8n-mcp` o `push` desde `workflows/`).
3. **Validar** con las herramientas de validación de `n8n-mcp` antes de desplegar.
4. Probar (ejecución manual o webhook de test `/webhook-test/...`).
5. **Publicar** — en n8n 2.x guardar NO pone en producción; hay que publicar.
6. `node scripts/n8n-sync.mjs pull` y commitear los JSON en `workflows/`.

## Comandos

```bash
docker compose up -d                 # levantar
docker compose ps                    # estado
docker compose logs -f n8n           # logs del main (o n8n-worker-1, n8n-worker-1-runner…)
node scripts/n8n-sync.mjs list --remote       # workflows en el servidor
node scripts/n8n-sync.mjs pull --remote       # servidor -> workflows/*.json
node scripts/n8n-sync.mjs push [f] --remote   # workflows/*.json -> servidor (crea o actualiza por id)
# sin --remote: mismas operaciones contra la instancia local
```

Backup de la base antes de cualquier upgrade:
```bash
set -a; . ./.env; set +a
docker exec n8n-postgres pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Fc > backups/n8n_db_$(date +%Y%m%d-%H%M).dump
```

## Reglas

- **Nunca** cambiar `N8N_ENCRYPTION_KEY`: se pierden todas las credenciales guardadas.
- **Nunca** commitear `.env`, `backups/` ni API keys. Las credenciales de n8n no se exportan en los JSON (solo referencias por id); al importar en otra instancia hay que re-vincularlas.
- No hacer downgrade de versión sin restaurar el backup: las migraciones de DB no son reversibles.
- Para borrar un workflow vía API primero hay que despublicarlo (`POST /workflows/{id}/deactivate`).
- En nodos Code, `$env` está bloqueado por defecto (`N8N_BLOCK_ENV_ACCESS_IN_NODE=true`); usar credenciales o variables de n8n.
- Python en nodos Code usa el runner nativo (`language: pythonNative`, datos en `_items`).
- `WEBHOOK_URL` está en `http://localhost:5678/`; para webhooks externos (WhatsApp, Telegram) cambiarlo a la URL pública del túnel y reiniciar `n8n`.
