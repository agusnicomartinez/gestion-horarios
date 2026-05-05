# Gestión de Horarios

App web mobile-first para que un supervisor gestione los turnos mensuales de un equipo pequeño (6 empleados) y para que cada empleado solicite vacaciones / días libres y consulte el cronograma publicado.

**Stack:** React + TypeScript + Vite · Supabase (Postgres + auth) · GitHub Pages · GitHub Actions.

---

## Estado actual

Setup inicial: proyecto Vite, dependencias (Supabase, React Router, date-fns), schema SQL, workflow de deploy y placeholder de UI. La aplicación se construye en la siguiente iteración.

---

## Setup local

### 1. Requisitos
- Node.js 20+
- Cuenta en [supabase.com](https://supabase.com) (free tier alcanza)

### 2. Crear proyecto en Supabase

1. Entrá a https://supabase.com → **New project**.
2. Nombre: `gestion-horarios`. Elegí región más cercana a Barcelona (eu-west).
3. Anotá la contraseña de la DB (no se usa desde el front, pero la vas a necesitar si querés conectarte por psql).
4. Esperá ~1 minuto a que aprovisione.
5. **Project Settings → API** copiá:
   - `Project URL` → va a `VITE_SUPABASE_URL`
   - `anon public` key → va a `VITE_SUPABASE_ANON_KEY`
6. **SQL Editor → New query** → pegá el contenido de [`supabase/schema.sql`](supabase/schema.sql) y ejecutalo. Crea tablas, enums, seed de festivos de Barcelona 2026 y políticas RLS.
7. **(Importante)** En la tabla `supervisors` ya hay un row con DNI `00000000A`. Editalo (Table Editor) y poné tu DNI real para poder loguearte como supervisor.

### 3. Variables de entorno

```bash
cp .env.example .env
# editá .env con las credenciales del paso 2.5
```

### 4. Correr en local

```bash
npm install
npm run dev
```

App en http://localhost:5173/gestion-horarios/

---

## Deploy a GitHub Pages

El deploy se dispara con cada **release publicada** (también manualmente vía `workflow_dispatch`).

### 1. Configurar secrets del repo

En GitHub → **Settings → Secrets and variables → Actions → New repository secret**:

- `VITE_SUPABASE_URL`
- `VITE_SUPABASE_ANON_KEY`

(Usá los mismos valores del `.env` local — la `anon key` es pública por diseño, pero pasarla por secret evita commitearla.)

### 2. Habilitar GitHub Pages

En GitHub → **Settings → Pages → Build and deployment → Source: GitHub Actions**.

### 3. Publicar una release

```bash
gh release create v0.1.0 --title "v0.1.0" --notes "Setup inicial"
```

El workflow `.github/workflows/deploy.yml` corre, buildea con las env vars como secrets, y publica en `https://agusnicomartinez.github.io/gestion-horarios/`.

> **404.html**: el workflow copia `index.html` a `404.html` para que las rutas SPA funcionen al refrescar en GitHub Pages.

---

## Modelo de autenticación (v0)

Login con DNI sin contraseña. Se valida contra las tablas `supervisors` y `employees`; la sesión vive en `localStorage`. RLS está activo pero permisivo para el rol `anon`; la autorización efectiva pasa por el cliente. Issue [#3](https://github.com/agusnicomartinez/gestion-horarios/issues/3) cambia esto a auth con contraseña + RLS basado en `auth.uid()`.

---

## Estructura

```
src/
  lib/         → cliente Supabase
  types/       → tipos TS de la DB
  pages/       → rutas (login, supervisor, employee)
  components/  → UI compartida
  hooks/       → hooks (useSession, useSchedule, ...)
supabase/
  schema.sql   → schema + seed
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
