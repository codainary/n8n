# 🔧 Mantenimiento

## Comandos Básicos

### Gestión de Servicios

```powershell
# Iniciar todos los servicios
docker compose up -d

# Detener todos los servicios
docker compose down

# Reiniciar un servicio específico
docker compose restart n8n

# Ver estado
docker compose ps

# Ver logs
docker compose logs -f
docker compose logs -f n8n --tail 100
```

### Ver Uso de Recursos

```powershell
# Tiempo real
docker stats

# Formato personalizado
docker stats --format "table {{.Name}}\t{{.CPUPerc}}\t{{.MemUsage}}\t{{.NetIO}}"
```

## Backups

### Backup de PostgreSQL

```powershell
# Crear backup
$fecha = Get-Date -Format "yyyyMMdd_HHmmss"
docker exec n8n-postgres pg_dump -U n8n_user n8n_db > "backup_$fecha.sql"

# Comprimir
Compress-Archive -Path "backup_$fecha.sql" -DestinationPath "backup_$fecha.zip"
```

### Restaurar PostgreSQL

```powershell
# Restaurar desde archivo
Get-Content backup_20241212.sql | docker exec -i n8n-postgres psql -U n8n_user -d n8n_db
```

### Backup Automatizado

Crear archivo `backup.ps1`:

```powershell
# backup.ps1
$backupDir = "C:\backups\n8n"
$fecha = Get-Date -Format "yyyyMMdd_HHmmss"
$archivo = "$backupDir\n8n_backup_$fecha.sql"

# Crear directorio si no existe
New-Item -ItemType Directory -Force -Path $backupDir | Out-Null

# Backup PostgreSQL
docker exec n8n-postgres pg_dump -U n8n_user n8n_db > $archivo

# Comprimir
Compress-Archive -Path $archivo -DestinationPath "$archivo.zip"
Remove-Item $archivo

# Limpiar backups viejos (mantener últimos 7)
Get-ChildItem $backupDir -Filter "*.zip" | 
    Sort-Object CreationTime -Descending | 
    Select-Object -Skip 7 | 
    Remove-Item

Write-Host "Backup completado: $archivo.zip"
```

Programar en Task Scheduler para ejecución diaria.

### Exportar Workflows (Manual)

Desde la UI de n8n:
1. Ir a cada workflow
2. Menu (⋮) → Download
3. Guarda archivo JSON

### Exportar Todos los Workflows (CLI)

```powershell
# Exportar workflows
docker exec n8n-main n8n export:workflow --all --output=/tmp/workflows.json

# Copiar a host
docker cp n8n-main:/tmp/workflows.json ./workflows_backup.json
```

## Logs

### Ver Logs por Servicio

```powershell
# n8n principal
docker compose logs n8n

# Workers
docker compose logs n8n-worker-1 n8n-worker-2

# PostgreSQL
docker compose logs postgres

# Redis
docker compose logs redis
```

### Filtrar Logs

```powershell
# Solo errores
docker compose logs n8n 2>&1 | Select-String "error|Error|ERROR"

# Últimas 100 líneas
docker compose logs n8n --tail 100

# Seguir en tiempo real
docker compose logs -f n8n

# Por fecha
docker compose logs --since "2024-12-12T10:00:00"
```

### Limpiar Logs

```powershell
# Ver espacio usado por logs
docker system df

# Limpiar logs de un contenedor
# (requiere detener el contenedor)
docker compose down
# Borrar manualmente en: \\wsl.localhost\docker-desktop-data\data\docker\containers\
docker compose up -d
```

## Actualizaciones

### Actualizar n8n

1. **Hacer backup primero:**
```powershell
docker exec n8n-postgres pg_dump -U n8n_user n8n_db > backup_pre_update.sql
```

2. **Cambiar versión en docker-compose.yml:**
```yaml
image: n8nio/n8n:1.71.0  # Nueva versión
```

3. **Actualizar:**
```powershell
docker compose pull
docker compose up -d
```

4. **Verificar:**
```powershell
docker compose logs n8n --tail 20
# Buscar: "Version: 1.71.0"
```

### Rollback

```powershell
# Cambiar versión anterior en docker-compose.yml
# image: n8nio/n8n:1.70.0

docker compose up -d

# Restaurar backup si es necesario
Get-Content backup_pre_update.sql | docker exec -i n8n-postgres psql -U n8n_user -d n8n_db
```

## Limpieza

### Limpiar Ejecuciones Antiguas

n8n lo hace automáticamente si está configurado:
```yaml
- EXECUTIONS_DATA_PRUNE=true
- EXECUTIONS_DATA_MAX_AGE=168  # 7 días
```

### Limpiar Manualmente (PostgreSQL)

```powershell
# Conectar a PostgreSQL
docker exec -it n8n-postgres psql -U n8n_user -d n8n_db

# Dentro de psql:
DELETE FROM execution_entity WHERE "createdAt" < NOW() - INTERVAL '30 days';
VACUUM ANALYZE execution_entity;
\q
```

### Limpiar Docker

```powershell
# Ver espacio usado
docker system df

# Limpiar imágenes no usadas
docker image prune

# Limpiar todo lo no usado (con cuidado)
docker system prune

# Limpiar volúmenes huérfanos (⚠️ PELIGROSO)
docker volume prune
```

## Troubleshooting

### n8n no inicia

```powershell
# Ver logs detallados
docker compose logs n8n

# Problemas comunes:
# 1. Encryption key mismatch
# 2. PostgreSQL no disponible
# 3. Puerto en uso
```

### Error de conexión a PostgreSQL

```powershell
# Verificar que postgres está corriendo
docker compose ps postgres

# Verificar conectividad
docker exec n8n-main ping postgres

# Ver logs de postgres
docker compose logs postgres
```

### Workflows no se ejecutan

```powershell
# Verificar workers
docker compose ps

# Ver cola de Redis
docker exec n8n-redis redis-cli -a <password> LLEN bull:jobs:waiting

# Reiniciar workers
docker compose restart n8n-worker-1 n8n-worker-2
```

### Alto uso de memoria

```powershell
# Ver uso actual
docker stats

# Reiniciar contenedores
docker compose restart

# Reducir concurrencia de workers
# Editar docker-compose.yml:
# - N8N_CONCURRENCY_PRODUCTION_LIMIT=5
```

### Resetear completamente

```powershell
# ⚠️ BORRA TODOS LOS DATOS
docker compose down -v
docker compose up -d

# Tendrás que crear nuevo usuario
```

## Health Checks

### Verificar Salud

```powershell
# n8n
Invoke-WebRequest http://localhost:5678/healthz

# PostgreSQL
docker exec n8n-postgres pg_isready -U n8n_user

# Redis
docker exec n8n-redis redis-cli -a <password> ping
```

### Script de Monitoreo

```powershell
# health-check.ps1
$services = @{
    "n8n" = "http://localhost:5678/healthz"
}

foreach ($service in $services.Keys) {
    try {
        $response = Invoke-WebRequest -Uri $services[$service] -TimeoutSec 5
        if ($response.StatusCode -eq 200) {
            Write-Host "✅ $service - OK" -ForegroundColor Green
        }
    } catch {
        Write-Host "❌ $service - FAILED" -ForegroundColor Red
    }
}

# Docker containers
docker compose ps --format "table {{.Name}}\t{{.Status}}"
```
