# Gestión de Horarios

App web mobile-first para que un supervisor gestione los turnos mensuales de un equipo pequeño (6 empleados) y para que cada empleado solicite vacaciones / días libres y consulte el cronograma publicado.

**Stack:** React + TypeScript + Vite · localStorage (v0) · GitHub Pages · GitHub Actions.

> **v0 — almacenamiento local:** los datos viven en el `localStorage` del navegador. Cada navegador/dispositivo tiene su propia copia, **no hay sincronización entre usuarios**. Apta para prototipo y para que un solo dispositivo pruebe todos los roles. La migración a backend SQL queda pendiente como issue separado; el schema está conservado en [`docs/future-sql-schema.sql`](docs/future-sql-schema.sql).

---

## Estado actual

Setup inicial: proyecto Vite, capa de datos en `localStorage` con tipos compartidos, seed de festivos de Barcelona 2026, workflow de deploy y placeholder de UI. La aplicación se construye en la siguiente iteración.

---

## Setup local

### 1. Requisitos
- Node.js 20+

### 2. Instalar y correr

```bash
npm install
npm run dev
```

App en http://localhost:5173/gestion-horarios/

No requiere variables de entorno ni cuentas externas.

### 3. Resetear los datos locales

En la consola del navegador:

```js
Object.keys(localStorage).filter(k => k.startsWith('gh:')).forEach(k => localStorage.removeItem(k))
```

O desde el código: `import { db } from './lib/db'; db.resetAll()`.

---

## Deploy a GitHub Pages

El deploy se dispara con cada **release publicada** (también manualmente vía `workflow_dispatch`).

### 1. Habilitar GitHub Pages

En GitHub → **Settings → Pages → Build and deployment → Source: GitHub Actions**.

### 2. Publicar una release

```bash
gh release create v0.1.0 --title "v0.1.0" --notes "Setup inicial"
```

El workflow `.github/workflows/deploy.yml` corre, buildea y publica en `https://agusnicomartinez.github.io/gestion-horarios/`.

> **404.html**: el workflow copia `index.html` a `404.html` para que las rutas SPA funcionen al refrescar en GitHub Pages.

---

## Modelo de autenticación (v0)

Login con DNI sin contraseña. Se valida contra los registros locales de supervisores y empleados; la sesión vive en una clave aparte del `localStorage`. Issue [#3](https://github.com/agusnicomartinez/gestion-horarios/issues/3) cambia esto a auth con contraseña cuando exista backend real.

---

## Capa de datos

Todo el acceso pasa por [`src/lib/db.ts`](src/lib/db.ts), que expone una API tipada y **asíncrona** sobre `localStorage`:

```ts
import { db } from './lib/db'

const employees = await db.employees.list()
const created = await db.employees.insert({ dni, full_name, shift_type, active, created_at })
await db.employees.update(id, { active: false })
```

La interfaz async es deliberada: cuando migremos a un backend real (Supabase, Postgres, etc.) las llamadas del consumer no cambian, solo se reemplaza el archivo `db.ts`.

---

## Estructura

```
src/
  lib/         → capa de datos (localStorage)
  types/       → tipos TS de las "tablas"
  pages/       → rutas (login, supervisor, employee)
  components/  → UI compartida
  hooks/       → hooks (useSession, useSchedule, ...)
docs/
  future-sql-schema.sql   → schema Postgres para la futura migración a backend real
.github/workflows/
  deploy.yml   → CI/CD a GitHub Pages
```

---

## Reglas del cronograma (resumen)

- 2 turnos/día: mañana 7-15, tarde 15-23. Mínimo 1 empleado/turno.
- Tras turno tarde, no puede haber mañana al día siguiente.
- Mín 4 / máx 7 días seguidos. 7 seguidos → 3 de descanso.
- Ratio 5:2 (trabajo:descanso). 1 fin de semana libre/mes mínimo.
- 31 vacaciones (bloques ≥ 7 días corridos), 3 personales, 14 festivos/año (defaults editables).
- Festivos de Barcelona pre-cargados (Catalunya + locales).

## Flujo mensual

| Fecha | Evento |
|---|---|
| Día 10 00:00 | Se abre ventana de solicitudes |
| Día 12 00:00 | Cierre de solicitudes + generación automática |
| Día 12 00:00 → 15 00:00 | Supervisor revisa y ajusta |
| Día 15 00:00 | Cronograma publicado |

---

## Roadmap

- [#1](https://github.com/agusnicomartinez/gestion-horarios/issues/1) Equipos de tamaño variable
- [#2](https://github.com/agusnicomartinez/gestion-horarios/issues/2) Dashboard con gráficos
- [#3](https://github.com/agusnicomartinez/gestion-horarios/issues/3) Autenticación con contraseña
- _(pendiente de crear)_ Migración de localStorage a backend SQL para sync multi-usuario
