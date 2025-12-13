# 👷 Sistema de Workers

## ¿Qué son los Workers?

Los workers son instancias de n8n que **solo ejecutan workflows**, sin servir la interfaz web. Permiten:

- ⚡ **Escalabilidad horizontal** - Agregar más workers según demanda
- 🔄 **Balanceo de carga** - Distribuir trabajo entre múltiples ejecutores
- 🛡️ **Resiliencia** - Si un worker falla, otros continúan
- 📈 **Alto rendimiento** - Procesar múltiples workflows simultáneamente

## Arquitectura Queue Mode

```
┌─────────────────┐
│   Webhook/      │
│   Trigger       │
└────────┬────────┘
         │
         ▼
┌─────────────────┐
│   n8n-main      │ ◄─── Recibe y encola
└────────┬────────┘
         │
         ▼
┌─────────────────┐
│     Redis       │ ◄─── Cola de trabajos
│     Queue       │
└────────┬────────┘
         │
    ┌────┴────┬────────┐
    │         │        │
    ▼         ▼        ▼
┌───────┐ ┌───────┐ ┌───────┐
│Worker1│ │Worker2│ │WorkerN│ ◄─── Ejecutan
└───────┘ └───────┘ └───────┘
```

## Configuración de Workers

### Variables Principales

```yaml
environment:
  # Modo queue obligatorio
  - EXECUTIONS_MODE=queue
  
  # Conexión a Redis
  - QUEUE_BULL_REDIS_HOST=redis
  - QUEUE_BULL_REDIS_PORT=6379
  - QUEUE_BULL_REDIS_PASSWORD=${REDIS_PASSWORD}
  
  # Configuración del worker
  - QUEUE_WORKER_TIMEOUT=60              # Timeout por job
  - N8N_CONCURRENCY_PRODUCTION_LIMIT=10  # Jobs simultáneos
  
  # Health check
  - QUEUE_HEALTH_CHECK_ACTIVE=true
```

### Parámetros de Rendimiento

| Parámetro | Descripción | Default | Rango |
|-----------|-------------|---------|-------|
| `N8N_CONCURRENCY_PRODUCTION_LIMIT` | Workflows simultáneos por worker | 10 | 1-50 |
| `QUEUE_WORKER_TIMEOUT` | Tiempo máximo por job (segundos) | 60 | 30-3600 |
| `QUEUE_HEALTH_CHECK_ACTIVE` | Verificación de salud | true | true/false |

## Escalar Workers

### Agregar Workers Temporalmente

```powershell
# Escalar a 4 workers tipo 1
docker compose up -d --scale n8n-worker-1=4

# Volver a 1 worker
docker compose up -d --scale n8n-worker-1=1
```

### Agregar Workers Permanentes

Editar `docker-compose.yml`:

```yaml
  n8n-worker-3:
    image: n8nio/n8n:1.70.0
    container_name: n8n-worker-3
    restart: always
    command: worker
    environment:
      - DB_TYPE=postgresdb
      - DB_POSTGRESDB_HOST=postgres
      - DB_POSTGRESDB_PORT=5432
      - DB_POSTGRESDB_DATABASE=${POSTGRES_DB}
      - DB_POSTGRESDB_USER=${POSTGRES_USER}
      - DB_POSTGRESDB_PASSWORD=${POSTGRES_PASSWORD}
      - EXECUTIONS_MODE=queue
      - QUEUE_BULL_REDIS_HOST=redis
      - QUEUE_BULL_REDIS_PORT=6379
      - QUEUE_BULL_REDIS_PASSWORD=${REDIS_PASSWORD}
      - N8N_ENCRYPTION_KEY=${N8N_ENCRYPTION_KEY}
      - GENERIC_TIMEZONE=${TIMEZONE}
      - TZ=${TIMEZONE}
    volumes:
      - n8n_data:/home/node/.n8n
    depends_on:
      - postgres
      - redis
      - n8n
    networks:
      - n8n-network
```

## Monitorear Workers

### Ver Logs

```powershell
# Logs de todos los workers
docker compose logs -f n8n-worker-1 n8n-worker-2

# Logs de un worker específico
docker compose logs -f n8n-worker-1 --tail 100

# Buscar errores
docker compose logs n8n-worker-1 2>&1 | Select-String "error"
```

### Ver Estado de Cola (Redis)

```powershell
# Conectar a Redis
docker exec -it n8n-redis redis-cli -a $env:REDIS_PASSWORD

# Comandos útiles dentro de redis-cli:
KEYS *                    # Ver todas las keys
LLEN bull:jobs:waiting    # Jobs en espera
LLEN bull:jobs:active     # Jobs activos
LLEN bull:jobs:completed  # Jobs completados
LLEN bull:jobs:failed     # Jobs fallidos
```

### Ver Uso de Recursos

```powershell
# Uso de CPU/RAM de workers
docker stats n8n-worker-1 n8n-worker-2

# Formato tabla
docker stats --format "table {{.Name}}\t{{.CPUPerc}}\t{{.MemUsage}}"
```

## Ajuste de Rendimiento

### Para Workflows Livianos (APIs, transformaciones)

```yaml
- N8N_CONCURRENCY_PRODUCTION_LIMIT=20  # Más concurrencia
- QUEUE_WORKER_TIMEOUT=30              # Timeout corto
```

### Para Workflows Pesados (archivos, ML, scraping)

```yaml
- N8N_CONCURRENCY_PRODUCTION_LIMIT=5   # Menos concurrencia
- QUEUE_WORKER_TIMEOUT=300             # Timeout largo (5 min)
```

### Para Alto Volumen

```yaml
# Más workers con menos concurrencia cada uno
# Mejor aislamiento de fallos
- N8N_CONCURRENCY_PRODUCTION_LIMIT=5

# Escalar horizontalmente
docker compose up -d --scale n8n-worker-1=5
```

## Troubleshooting

### Worker no procesa jobs

1. Verificar conexión a Redis:
```powershell
docker exec n8n-worker-1 ping redis
```

2. Verificar conexión a PostgreSQL:
```powershell
docker exec n8n-worker-1 ping postgres
```

3. Ver logs detallados:
```powershell
docker compose logs n8n-worker-1 --tail 50
```

### Jobs se quedan en "waiting"

```powershell
# Verificar que hay workers activos
docker compose ps

# Reiniciar workers
docker compose restart n8n-worker-1 n8n-worker-2
```

### Worker consume mucha memoria

```yaml
# Reducir concurrencia
- N8N_CONCURRENCY_PRODUCTION_LIMIT=5

# O agregar límites estrictos
deploy:
  resources:
    limits:
      memory: 512M
```

## Métricas Prometheus

Si `N8N_METRICS=true`, disponible en `http://localhost:5678/metrics`:

```
# Jobs procesados
n8n_workflow_executions_total

# Tiempo de ejecución
n8n_workflow_execution_duration_seconds

# Jobs en cola
n8n_queue_jobs_waiting
n8n_queue_jobs_active
```
