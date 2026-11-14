# 🚀 n8n con PostgreSQL, Redis y Workers

Configuración de n8n en modo **Queue** con balanceo de carga usando workers.

## 📋 Arquitectura

```
                    ┌─────────────────┐
                    │    Internet     │
                    └────────┬────────┘
                             │
                    ┌────────▼────────┐
                    │  ngrok / Nginx  │
                    └────────┬────────┘
                             │
                    ┌────────▼────────┐
                    │   n8n Main      │◄──── UI & Webhooks
                    │   (port 5678)   │
                    └────────┬────────┘
                             │
              ┌──────────────┼──────────────┐
              │              │              │
     ┌────────▼────┐  ┌──────▼──────┐  ┌────▼────────┐
     │   Redis     │  │  PostgreSQL │  │             │
     │  (Queue)    │  │    (DB)     │  │             │
     └──────┬──────┘  └─────────────┘  │             │
            │                          │             │
     ┌──────┴──────────────────────────┤             │
     │              │                  │             │
┌────▼─────┐  ┌─────▼────┐       ┌─────▼────┐       │
│ Worker 1 │  │ Worker 2 │  ...  │ Worker N │       │
└──────────┘  └──────────┘       └──────────┘       │
```

## 🛠️ Requisitos

- Docker Desktop instalado
- Docker Compose v2+
- Mínimo 4GB RAM disponible

## ⚡ Guía Rápida

### 1. Configurar variables de entorno

```powershell
# Copiar archivo de ejemplo
Copy-Item .env.example .env

# Editar con tus valores
notepad .env
```

> **Obligatorio en n8n 2.x:** completa `N8N_RUNNERS_AUTH_TOKEN` (genera uno con `openssl rand -hex 32`); sin él los task runners no se conectan y los nodos Code fallan. `N8N_API_KEY` se crea después en *Settings > n8n API*.

### 2. Iniciar todos los servicios

```powershell
# Levantar todo en segundo plano
docker-compose up -d

# Ver logs en tiempo real
docker-compose logs -f
```

### 3. Verificar que todo esté corriendo

```powershell
# Ver estado de contenedores
docker-compose ps

# Verificar health checks
docker inspect n8n-main --format='{{.State.Health.Status}}'
```

### 4. Acceder a n8n

- **URL Local:** http://localhost:5678
- **URL Pública:** https://fitful-makenzie-unnaturalistic.ngrok-free.dev

## 📝 Comandos Útiles

### Gestión de Servicios

```powershell
# Iniciar
docker-compose up -d

# Detener
docker-compose down

# Reiniciar
docker-compose restart

# Ver logs
docker-compose logs -f n8n
docker-compose logs -f n8n-worker-1
docker-compose logs -f n8n-worker-2

# Ver logs de todos
docker-compose logs -f
```

### Escalar Workers

```powershell
# Agregar más workers dinámicamente
docker-compose up -d --scale n8n-worker-1=1 --scale n8n-worker-2=3
```

### Mantenimiento de Base de Datos

```powershell
# Acceder a PostgreSQL
docker exec -it n8n-postgres psql -U n8n_user -d n8n_db

# Backup de la base de datos
docker exec n8n-postgres pg_dump -U n8n_user n8n_db > backup_$(Get-Date -Format "yyyyMMdd").sql

# Restaurar backup
Get-Content backup.sql | docker exec -i n8n-postgres psql -U n8n_user -d n8n_db
```

### Monitorear Redis

```powershell
# Ver estado de las colas
docker exec -it n8n-redis redis-cli -a R3d1s_Secure_P@ss_2024! INFO

# Ver keys activas
docker exec -it n8n-redis redis-cli -a R3d1s_Secure_P@ss_2024! KEYS "*"

# Monitor en tiempo real
docker exec -it n8n-redis redis-cli -a R3d1s_Secure_P@ss_2024! MONITOR
```

## 🔧 Configuración de Workers

| Variable | Descripción | Default |
|----------|-------------|---------|
| `N8N_CONCURRENCY_PRODUCTION_LIMIT` | Workflows simultáneos por worker | 10 |
| `N8N_GRACEFUL_SHUTDOWN_TIMEOUT` | Espera máxima al apagar el worker (s) | 60 |
| `QUEUE_HEALTH_CHECK_ACTIVE` | Health check activo | true |

### Ajustar concurrencia

Edita en `docker-compose.yml`:
```yaml
environment:
  - N8N_CONCURRENCY_PRODUCTION_LIMIT=20  # Más workflows simultáneos
```

## 🔒 Seguridad

### Cambiar contraseñas

1. Edita `.env` con nuevas contraseñas
2. Reinicia los servicios:
```powershell
docker-compose down
docker-compose up -d
```

### Generar nueva Encryption Key

```powershell
# En PowerShell
[Convert]::ToBase64String((1..32 | ForEach-Object { Get-Random -Maximum 256 }))

# O usando OpenSSL
openssl rand -base64 32
```

⚠️ **IMPORTANTE:** Si cambias la encryption key, perderás acceso a credenciales existentes.

## 📊 Monitoreo

### Health Endpoints

- **n8n:** http://localhost:5678/healthz
- **Metrics:** http://localhost:5678/metrics (si habilitado)

### Ver uso de recursos

```powershell
docker stats
```

## 🆘 Troubleshooting

### n8n no inicia

```powershell
# Ver logs detallados
docker-compose logs n8n

# Verificar que postgres esté listo
docker-compose logs postgres
```

### Workers no procesan

```powershell
# Verificar conexión a Redis
docker exec -it n8n-worker-1 ping redis

# Ver logs del worker
docker-compose logs -f n8n-worker-1
```

### Resetear todo

```powershell
# ⚠️ CUIDADO: Esto borra todos los datos
docker-compose down -v
docker-compose up -d
```

## 📁 Estructura de Archivos

```
n8n/
├── docker-compose.yml    # Configuración de servicios
├── .env                  # Variables de entorno (NO commitear)
├── .env.example          # Ejemplo de variables
├── .gitignore            # Archivos ignorados por git
├── README.md             # Esta guía
└── n8n/
    └── nodes/            # Nodos personalizados
        └── package.json
```

## 🔄 Migración desde SQLite

Si tenías datos en SQLite, exporta los workflows desde la UI antes de migrar:
1. Abre n8n con la configuración anterior
2. Ve a cada workflow → Menu → Download
3. Levanta la nueva configuración
4. Importa los workflows descargados

---

**Creado:** Diciembre 2024  
**Versión n8n:** 1.70.0
