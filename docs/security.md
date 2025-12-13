# 🔒 Seguridad

## Mejores Prácticas

### 1. Variables de Entorno

**❌ NUNCA** guardar credenciales en `docker-compose.yml`:
```yaml
# MAL
environment:
  - POSTGRES_PASSWORD=miPassword123
```

**✅ SIEMPRE** usar archivo `.env`:
```yaml
# BIEN
environment:
  - POSTGRES_PASSWORD=${POSTGRES_PASSWORD}
```

### 2. Encryption Key

La `N8N_ENCRYPTION_KEY` cifra todas las credenciales en la base de datos.

**Generar una key segura:**

```powershell
# PowerShell
[Convert]::ToBase64String((1..32 | ForEach-Object { Get-Random -Maximum 256 }))

# OpenSSL
openssl rand -base64 32
```

**⚠️ IMPORTANTE:**
- Guardar en lugar seguro (password manager)
- Si la pierdes, pierdes acceso a TODAS las credenciales
- NO cambiarla una vez en producción

### 3. Contraseñas Seguras

Requisitos mínimos:
- 16+ caracteres
- Mayúsculas y minúsculas
- Números
- Caracteres especiales

**Generador PowerShell:**
```powershell
-join ((48..57) + (65..90) + (97..122) + (33,35,36,37,38,42,64) | Get-Random -Count 20 | ForEach-Object {[char]$_})
```

### 4. Archivos a Proteger

Agregar a `.gitignore`:
```gitignore
# NUNCA commitear
.env
.env.*
!.env.example

# Datos sensibles
n8n/config
n8n/database.sqlite
*.sql
backups/
```

## Configuración de Red

### Puerto Solo Localhost

```yaml
ports:
  - "127.0.0.1:5678:5678"  # Solo accesible localmente
```

**NO usar:**
```yaml
ports:
  - "5678:5678"  # Expuesto a toda la red
  - "0.0.0.0:5678:5678"  # Igual de peligroso
```

### Red Interna Docker

Los servicios se comunican por red interna:
```yaml
networks:
  - n8n-network  # Red privada
```

PostgreSQL y Redis **NO** están expuestos externamente.

## Acceso Externo Seguro

### Opción 1: ngrok (Desarrollo)

```powershell
ngrok http 5678
```

Pros:
- Fácil de configurar
- HTTPS automático

Contras:
- URL cambia cada vez (plan gratuito)
- Dependencia externa

### Opción 2: Reverse Proxy + SSL (Producción)

**Nginx ejemplo:**
```nginx
server {
    listen 443 ssl http2;
    server_name n8n.tudominio.com;

    ssl_certificate /etc/letsencrypt/live/n8n.tudominio.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/n8n.tudominio.com/privkey.pem;

    location / {
        proxy_pass http://127.0.0.1:5678;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
```

## Autenticación n8n

### Sistema de Usuarios

n8n v1.0+ usa autenticación integrada:

| Rol | Permisos |
|-----|----------|
| Owner | Todo, incluido gestión de usuarios |
| Admin | Gestión de workflows y credenciales |
| Member | Usar workflows asignados |

### Configuración de Sesión

```env
# Duración de sesión (horas)
N8N_USER_MANAGEMENT_JWT_DURATION_HOURS=168  # 7 días
```

### Recuperación de Contraseña

Requiere configurar SMTP:
```env
N8N_EMAIL_MODE=smtp
N8N_SMTP_HOST=smtp.gmail.com
N8N_SMTP_PORT=465
N8N_SMTP_USER=tu@email.com
N8N_SMTP_PASS=app_password
N8N_SMTP_SSL=true
```

## Base de Datos

### PostgreSQL

- **Credenciales:** Solo en `.env`
- **Acceso:** Solo desde red Docker interna
- **Puerto:** No expuesto externamente

### Redis

- **Autenticación:** Habilitada con password
- **Persistencia:** AOF enabled
- **Acceso:** Solo red interna

```yaml
command: redis-server --appendonly yes --requirepass ${REDIS_PASSWORD}
```

## Credenciales en n8n

### Cómo se Almacenan

1. Usuario crea credencial en UI
2. n8n cifra con `N8N_ENCRYPTION_KEY`
3. Se guarda cifrado en PostgreSQL
4. Se descifra solo al ejecutar workflow

### Auditoría

Ver credenciales usadas:
```sql
-- Conectar a PostgreSQL
docker exec -it n8n-postgres psql -U n8n_user -d n8n_db

-- Ver credenciales (sin datos sensibles)
SELECT id, name, type, "createdAt" FROM credentials_entity;
```

## Checklist de Seguridad

### Pre-Producción

- [ ] Cambiar todas las contraseñas por defecto
- [ ] Generar nueva `N8N_ENCRYPTION_KEY`
- [ ] Configurar `.gitignore` correctamente
- [ ] Verificar que `.env` no está en el repositorio
- [ ] Puerto 5678 solo en localhost
- [ ] Configurar reverse proxy con SSL
- [ ] Backup de encryption key en lugar seguro

### Operación

- [ ] Backups regulares de PostgreSQL
- [ ] Monitorear logs por accesos sospechosos
- [ ] Actualizar n8n periódicamente
- [ ] Rotar contraseñas cada 90 días
- [ ] Revisar usuarios activos

### Monitoreo

```powershell
# Ver intentos de login fallidos
docker compose logs n8n | Select-String "authentication failed"

# Ver accesos recientes
docker compose logs n8n | Select-String "logged in"
```

## Recuperación de Desastres

### Si pierdes la Encryption Key

**No hay recuperación.** Las credenciales están cifradas y no se pueden descifrar.

**Pasos:**
1. Exportar workflows (JSON) - no incluyen credenciales
2. Resetear base de datos
3. Crear nueva encryption key
4. Importar workflows
5. Recrear todas las credenciales manualmente

### Si comprometen las credenciales

1. Detener n8n inmediatamente:
```powershell
docker compose down
```

2. Cambiar todas las contraseñas:
   - PostgreSQL
   - Redis
   - Encryption Key (implica recrear credenciales)

3. Rotar credenciales de servicios externos usados en workflows

4. Revisar logs por accesos no autorizados

5. Levantar con nuevas credenciales
