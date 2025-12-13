# 🏗️ Arquitectura del Sistema

## Diagrama General

```
                        ┌─────────────────────────────────────┐
                        │            INTERNET                 │
                        └──────────────────┬──────────────────┘
                                           │
                        ┌──────────────────▼──────────────────┐
                        │     ngrok / Reverse Proxy           │
                        │   (SSL Termination + Routing)       │
                        └──────────────────┬──────────────────┘
                                           │
┌──────────────────────────────────────────┼──────────────────────────────────────────┐
│                              DOCKER NETWORK (n8n-network)                           │
│                                          │                                          │
│                        ┌─────────────────▼─────────────────┐                       │
│                        │         n8n-main                   │                       │
│                        │    (UI + Webhooks + API)           │                       │
│                        │       Port: 5678                   │                       │
│                        └───────┬───────────────┬────────────┘                       │
│                                │               │                                    │
│              ┌─────────────────┼───────────────┼─────────────────┐                  │
│              │                 │               │                 │                  │
│    ┌─────────▼─────────┐ ┌─────▼─────┐ ┌──────▼──────┐ ┌────────▼────────┐         │
│    │   PostgreSQL      │ │   Redis   │ │  Worker 1   │ │    Worker 2     │         │
│    │   (Persistence)   │ │  (Queue)  │ │ (Executor)  │ │   (Executor)    │         │
│    │   Port: 5432      │ │Port: 6379 │ │             │ │                 │         │
│    └───────────────────┘ └───────────┘ └─────────────┘ └─────────────────┘         │
│                                                                                     │
└─────────────────────────────────────────────────────────────────────────────────────┘
```

## Componentes

### 1. n8n-main (Instancia Principal)
- **Función:** Sirve la interfaz web, recibe webhooks y encola trabajos
- **Puerto:** 5678 (expuesto solo a localhost)
- **Recursos:** 1 CPU, 1GB RAM

### 2. PostgreSQL
- **Función:** Almacena workflows, credenciales, usuarios y ejecuciones
- **Puerto interno:** 5432
- **Versión:** 16-alpine
- **Persistencia:** Volume `postgres_data`

### 3. Redis
- **Función:** Cola de mensajes para distribuir trabajo a workers
- **Puerto interno:** 6379
- **Versión:** 7-alpine
- **Persistencia:** Volume `redis_data` (AOF enabled)

### 4. Workers (n8n-worker-1, n8n-worker-2)
- **Función:** Ejecutan los workflows de forma distribuida
- **Concurrencia:** 10 workflows simultáneos por worker
- **Timeout:** 60 segundos por job

## Flujo de Datos

```
1. Usuario crea workflow en UI
          │
          ▼
2. Workflow se guarda en PostgreSQL
          │
          ▼
3. Trigger activa workflow (webhook, cron, manual)
          │
          ▼
4. n8n-main encola job en Redis
          │
          ▼
5. Worker disponible toma el job de Redis
          │
          ▼
6. Worker ejecuta el workflow
          │
          ▼
7. Resultado se guarda en PostgreSQL
          │
          ▼
8. Usuario ve resultado en UI
```

## Volúmenes Docker

| Volumen | Contenido | Crítico |
|---------|-----------|---------|
| `postgres_data` | Base de datos completa | ⚠️ SÍ |
| `redis_data` | Cola de trabajos | No |
| `n8n_data` | Configuración n8n | No |
| `./n8n/nodes` | Nodos personalizados | Opcional |

## Red Docker

- **Nombre:** `n8n-network`
- **Driver:** bridge
- **Comunicación:** Todos los contenedores pueden comunicarse por nombre

## Escalabilidad

### Horizontal (Workers)
```powershell
# Agregar más workers
docker compose up -d --scale n8n-worker-1=3
```

### Vertical (Recursos)
Editar `docker-compose.yml`:
```yaml
deploy:
  resources:
    limits:
      cpus: '2'
      memory: 2G
```
