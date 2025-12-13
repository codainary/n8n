# 📚 Documentación n8n

Documentación completa para la configuración de n8n con PostgreSQL, Redis y Workers.

## 📖 Índice

1. [Arquitectura](./architecture.md) - Diagrama y componentes del sistema
2. [Instalación](./installation.md) - Guía paso a paso para levantar el sistema
3. [Configuración](./configuration.md) - Variables de entorno y opciones
4. [Workers](./workers.md) - Sistema de colas y balanceo de carga
5. [Mantenimiento](./maintenance.md) - Backups, logs y troubleshooting
6. [Seguridad](./security.md) - Mejores prácticas de seguridad

## 🚀 Quick Start

```powershell
# 1. Copiar archivo de configuración
Copy-Item .env.example .env

# 2. Editar variables (opcional)
notepad .env

# 3. Levantar servicios
docker compose up -d

# 4. Acceder a n8n
# http://localhost:5678
```

## 📋 Requisitos

- Docker Desktop 4.0+
- Docker Compose v2+
- 4GB RAM mínimo
- 10GB espacio en disco

## 🏗️ Stack Tecnológico

| Componente | Tecnología | Versión |
|------------|------------|---------|
| Automatización | n8n | 1.70.0 |
| Base de datos | PostgreSQL | 16-alpine |
| Cache/Queue | Redis | 7-alpine |
| Contenedores | Docker | Latest |
