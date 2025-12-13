# 🚀 Guía de Instalación

## Requisitos Previos

### Software
- [Docker Desktop](https://www.docker.com/products/docker-desktop/) 4.0+
- [Git](https://git-scm.com/) (opcional)

### Hardware Mínimo
| Recurso | Mínimo | Recomendado |
|---------|--------|-------------|
| RAM | 4GB | 8GB |
| CPU | 2 cores | 4 cores |
| Disco | 10GB | 20GB |

## Instalación Paso a Paso

### 1. Clonar o Descargar el Proyecto

```powershell
# Si tienes git
git clone <tu-repositorio> n8n
cd n8n

# O simplemente navegar a la carpeta
cd C:\Users\USER\projects\n8n
```

### 2. Configurar Variables de Entorno

```powershell
# Copiar archivo de ejemplo
Copy-Item .env.example .env

# Editar con tus valores
notepad .env
```

#### Variables Requeridas

| Variable | Descripción | Ejemplo |
|----------|-------------|---------|
| `POSTGRES_PASSWORD` | Contraseña de PostgreSQL | `Mi_P@ss_Segur0!` |
| `REDIS_PASSWORD` | Contraseña de Redis | `R3d1s_Segur0!` |
| `N8N_ENCRYPTION_KEY` | Clave para cifrar credenciales | Ver generación abajo |
| `WEBHOOK_URL` | URL pública para webhooks | `https://mi-dominio.com` |
| `TIMEZONE` | Zona horaria | `America/Mexico_City` |

#### Generar Encryption Key

```powershell
# PowerShell
[Convert]::ToBase64String((1..32 | ForEach-Object { Get-Random -Maximum 256 }))

# O usando OpenSSL (si está instalado)
openssl rand -base64 32
```

### 3. Iniciar los Servicios

```powershell
# Levantar todo en segundo plano
docker compose up -d

# Ver el progreso
docker compose logs -f
```

### 4. Verificar Estado

```powershell
# Ver estado de contenedores
docker compose ps

# Esperado:
# n8n-postgres   Up (healthy)
# n8n-redis      Up (healthy)
# n8n-main       Up (healthy)
# n8n-worker-1   Up
# n8n-worker-2   Up
```

### 5. Acceder a n8n

1. Abrir navegador: **http://localhost:5678**
2. Crear cuenta de administrador (primera vez)
3. ¡Listo para crear workflows!

## Primera Configuración

### Crear Usuario Owner

La primera vez que accedas, verás un formulario:

```
┌─────────────────────────────────────┐
│       Setup your account            │
├─────────────────────────────────────┤
│  Email:      [tu@email.com    ]     │
│  First Name: [Tu Nombre       ]     │
│  Last Name:  [Tu Apellido     ]     │
│  Password:   [***************]      │
│                                     │
│         [ Create Account ]          │
└─────────────────────────────────────┘
```

> ⚠️ **Importante:** Este usuario será el **Owner** con permisos totales.

## Configurar Acceso Externo (Webhooks)

### Opción A: ngrok (Desarrollo)

```powershell
# Instalar ngrok
winget install ngrok

# Autenticarse (crear cuenta en ngrok.com)
ngrok config add-authtoken <tu-token>

# Exponer n8n
ngrok http 5678
```

Actualizar `.env` con la URL de ngrok:
```env
WEBHOOK_URL=https://xxxx-xxx-xxx.ngrok-free.dev
```

### Opción B: Dominio Propio (Producción)

1. Configurar DNS apuntando a tu servidor
2. Configurar reverse proxy (Nginx/Traefik)
3. Actualizar `WEBHOOK_URL` en `.env`
4. Reiniciar: `docker compose restart n8n`

## Verificar Instalación

### Test de Salud

```powershell
# Health check
Invoke-WebRequest http://localhost:5678/healthz

# Esperado: StatusCode 200
```

### Test de Workers

1. Crear un workflow simple con un nodo "Schedule Trigger"
2. Ejecutar manualmente
3. Verificar en logs que un worker lo procesó:

```powershell
docker compose logs n8n-worker-1 --tail 20
```

## Troubleshooting

### Contenedor no inicia

```powershell
# Ver logs detallados
docker compose logs n8n

# Problemas comunes:
# - Puerto 5678 en uso
# - Encryption key inválida
# - PostgreSQL no disponible
```

### Limpiar y reiniciar

```powershell
# Detener todo
docker compose down

# Limpiar volúmenes (⚠️ BORRA DATOS)
docker compose down -v

# Reiniciar
docker compose up -d
```

### Verificar recursos

```powershell
# Ver uso de recursos
docker stats
```
