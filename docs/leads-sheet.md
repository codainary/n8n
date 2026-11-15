# Sheet «Automaverso · Leads» — estructura

Spreadsheet `1huKPPW_kkbLVsw6jSpMXUgD74I9o5Jvk8v6N9_kHXcA` (propietario hello@automaverso.com).
Solo guarda **leads** y sus **diagnósticos** (hechos en el website o por WhatsApp). No guarda agendamientos
(reuniones, enlaces de Meet, etc.). Lo llenan el **website** y el **bot de WhatsApp**.
Estructura generada por `scripts/leads-sheet-setup.mjs` (solo se puede re-ejecutar con el Sheet vacío).

**Relación**: una persona = una fila en **Leads** (clave `Lead ID`). Cada diagnóstico = una fila en
**Diagnósticos** (clave `Diagnóstico ID`), con el `Lead ID` al que pertenece. En Leads, `Diagnóstico ID`
guarda el **último** diagnóstico de esa persona. Para buscar a una persona existente: comparar
`WhatsApp / teléfono` solo por dígitos (últimos 10) y/o `Correo` en minúsculas.

## Hoja `Leads` (A–L)

| Col | Columna | Contenido | Quién la llena |
|---|---|---|---|
| A | Lead ID | `WEB-…` (website) o `WA-…` (bot). Único. | ambos |
| B | Etapa | Lista: **Contacto solicitado** · **Diagnosticado** | ambos (avanza, no retrocede) |
| C | Nombre o empresa | | ambos |
| D | WhatsApp / teléfono | Número con indicativo, formato `+57 315 342 2554`. Si eligió llamada a otro número, ese número. | ambos |
| E | Medio de contacto | Lista: Chat de WhatsApp · Llamada por WhatsApp · Llamada al celular · Correo | bot (website opcional) |
| F | Correo | | website |
| G | Diagnóstico ID | Último diagnóstico (hoja Diagnósticos). Vacío = no ha hecho diagnóstico. | ambos |
| H | Resumen conversación (WhatsApp) | Resumen breve de la conversación con el bot | bot |
| I | Canal de entrada | Lista: Website · WhatsApp (por dónde llegó la primera vez) | ambos |
| J | Origen (UTM) | utm_source/medium/campaign | website |
| K | Creado | `yyyy-mm-dd hh:mm` (hora Colombia) | ambos (solo al crear) |
| L | Actualizado | `yyyy-mm-dd hh:mm` (hora Colombia) | ambos (en cada cambio) |

## Hoja `Diagnósticos` (A–P)

| Col | Columna | Contenido |
|---|---|---|
| A | Diagnóstico ID | Único (p. ej. `DIAG-…`) |
| B | Lead ID | Persona a la que pertenece (hoja Leads) |
| C | Fecha | `yyyy-mm-dd hh:mm` (hora Colombia) |
| D | Canal | Lista: Website · WhatsApp (dónde se hizo el diagnóstico) |
| E | Idioma | `es` / `en` |
| F | País | |
| G | Sector | |
| H | Tamaño | |
| I | Cargo | |
| J | Presupuesto | |
| K | Plazo | |
| L | Áreas | |
| M | Horas manuales/semana | número |
| N | Ahorro anual estimado (US$) | número |
| O | Calificación | |
| P | Reporte | enlace |

## Cambios respecto a la versión anterior (para el website)

- Antes había **una sola hoja** con 22 columnas (`Actualizado, Lead ID, Etapa, Nombre o empresa, Presupuesto,
  WhatsApp, Correo, País, Sector, Tamaño, Cargo, Plazo, Áreas, Horas manuales/semana, Ahorro anual estimado (US$),
  Calificación, Asesoría (hora Colombia), Enlace Meet, Reporte, Idioma, Origen (UTM), Creado`).
- Pasan a **Diagnósticos**: Idioma, País, Sector, Tamaño, Cargo, Presupuesto, Plazo, Áreas, Horas
  manuales/semana, Ahorro anual estimado, Calificación, Reporte (+ Diagnóstico ID, Lead ID, Fecha, Canal).
- `WhatsApp` → **`WhatsApp / teléfono`**. Nuevas en Leads: Medio de contacto, Diagnóstico ID,
  Resumen conversación (WhatsApp), Canal de entrada. `Actualizado` pasa al final.
- **Eliminadas** (el Sheet no guarda agendamientos): Asesoría (hora Colombia), Enlace Meet y la etapa
  «Asesoría agendada».
- Flujo sugerido del website al terminar un diagnóstico: buscar el lead (teléfono/correo) → crear o actualizar
  su fila en Leads (Etapa = Diagnosticado si estaba en Contacto solicitado) → agregar fila en Diagnósticos →
  escribir su `Diagnóstico ID` en Leads. Escribir siempre **por nombre de columna**, no por posición.
