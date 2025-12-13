# ⚙️ Configuración

## Variables de Entorno

### Base de Datos (PostgreSQL)

| Variable | Descripción | Default | Requerido |
|----------|-------------|---------|-----------|
| `POSTGRES_USER` | Usuario de la base de datos | - | ✅ |
| `POSTGRES_PASSWORD` | Contraseña del usuario | - | ✅ |
| `POSTGRES_DB` | Nombre de la base de datos | - | ✅ |

### Redis (Sistema de Colas)

| Variable | Descripción | Default | Requerido |
|----------|-------------|---------|-----------|
| `REDIS_PASSWORD` | Contraseña de Redis | - | ✅ |

### Seguridad n8n

| Variable | Descripción | Default | Requerido |
|----------|-------------|---------|-----------|
| `N8N_ENCRYPTION_KEY` | Clave para cifrar credenciales | - | ✅ |
| `N8N_USER_MANAGEMENT_JWT_DURATION_HOURS` | Duración de sesión (horas) | 168 | ❌ |

> ⚠️ **IMPORTANTE:** Si cambias `N8N_ENCRYPTION_KEY`, perderás acceso a todas las credenciales existentes.

### Configuración General

| Variable | Descripción | Default | Requerido |
|----------|-------------|---------|-----------|
| `N8N_HOST` | Host interno | localhost | ❌ |
| `WEBHOOK_URL` | URL pública para webhooks | - | ✅ |
| `TIMEZONE` | Zona horaria | UTC | ❌ |

## Configuración Interna (docker-compose.yml)

### n8n Main

```yaml
environment:
  # Base de datos
  - DB_TYPE=postgresdb
  - DB_POSTGRESDB_HOST=postgres
  - DB_POSTGRESDB_PORT=5432
  
  # Modo Queue (workers)
  - EXECUTIONS_MODE=queue
  
  # Logging
  - N8N_LOG_LEVEL=info          # debug, info, warn, error
  
  # Métricas (Prometheus)
  - N8N_METRICS=true
  - N8N_METRICS_PREFIX=n8n_
  
  # Ejecuciones
  - EXECUTIONS_DATA_PRUNE=true           # Auto-limpieza
  - EXECUTIONS_DATA_MAX_AGE=168          # Retención en horas (7 días)
  - EXECUTIONS_DATA_SAVE_ON_ERROR=all    # Guardar en error
  - EXECUTIONS_DATA_SAVE_ON_SUCCESS=all  # Guardar en éxito
  
  # Límites
  - N8N_PAYLOAD_SIZE_MAX=16              # MB máximo de payload
```

### Workers

```yaml
environment:
  - QUEUE_WORKER_TIMEOUT=60              # Timeout por job (segundos)
  - N8N_CONCURRENCY_PRODUCTION_LIMIT=10  # Workflows simultáneos
```

## Zonas Horarias

Configurar correctamente para triggers programados:

```env
TIMEZONE=America/Mexico_City
```

### Zonas Comunes

| Ciudad | Valor |
|--------|-------|
| Ciudad de México | `America/Mexico_City` |
| Bogotá | `America/Bogota` |
| Buenos Aires | `America/Argentina/Buenos_Aires` |
| Lima | `America/Lima` |
| Santiago | `America/Santiago` |
| Madrid | `Europe/Madrid` |
| Nueva York | `America/New_York` |

Lista completa: [Wikipedia - TZ Database](https://en.wikipedia.org/wiki/List_of_tz_database_time_zones)

## Límites de Recursos

### Configuración por Defecto

```yaml
deploy:
  resources:
    limits:
      cpus: '1'
      memory: 1G
```

### Ajustar para Alto Rendimiento

```yaml
deploy:
  resources:
    limits:
      cpus: '2'
      memory: 2G
    reservations:
      cpus: '0.5'
      memory: 512M
```

## Retención de Datos

### Ejecuciones

```yaml
# Auto-limpiar ejecuciones antiguas
- EXECUTIONS_DATA_PRUNE=true

# Mantener ejecuciones por X horas
- EXECUTIONS_DATA_MAX_AGE=168    # 7 días
- EXECUTIONS_DATA_MAX_AGE=720    # 30 días
- EXECUTIONS_DATA_MAX_AGE=2160   # 90 días
```

### Qué Guardar

```yaml
# Guardar todas las ejecuciones
- EXECUTIONS_DATA_SAVE_ON_ERROR=all
- EXECUTIONS_DATA_SAVE_ON_SUCCESS=all
- EXECUTIONS_DATA_SAVE_MANUAL_EXECUTIONS=true

# Solo guardar errores (ahorra espacio)
- EXECUTIONS_DATA_SAVE_ON_ERROR=all
- EXECUTIONS_DATA_SAVE_ON_SUCCESS=none
```

## Niveles de Log

| Nivel | Descripción | Uso |
|-------|-------------|-----|
| `error` | Solo errores | Producción |
| `warn` | Errores y advertencias | Producción |
| `info` | Información general | Recomendado |
| `debug` | Todo detallado | Desarrollo |

```yaml
- N8N_LOG_LEVEL=info
```

## Ejemplo Completo .env

```env
# ==========================================
# n8n Environment Configuration
# ==========================================

# PostgreSQL
POSTGRES_USER=n8n_user
POSTGRES_PASSWORD=Super_Secure_P@ssw0rd_2024!
POSTGRES_DB=n8n_db

# Redis
REDIS_PASSWORD=R3d1s_Secure_P@ss_2024!

# Security
N8N_ENCRYPTION_KEY=tu_clave_base64_de_32_caracteres

# Session
N8N_USER_MANAGEMENT_JWT_DURATION_HOURS=300

# Configuration
N8N_HOST=localhost
WEBHOOK_URL=https://tu-dominio.com

# Timezone
TIMEZONE=America/Mexico_City
```
