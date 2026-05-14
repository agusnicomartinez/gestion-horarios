import type {
  ConventionSettings,
  CoverageOverride,
  DayRequest,
  Employee,
  PublicHoliday,
  ScheduleEntry,
  Shift,
  WorkShift,
} from '../types/database'
import { eachDayInMonth, fromISO, toISO, addDays } from './dates'
import { format } from 'date-fns'

/**
 * Schedule generation algorithm — v4 (rediseño en 3 fases).
 *
 * Reglas duras (del convenio, configurables en GlobalSettings.convention):
 *   - max_consecutive_work_days: ciclo máximo (default 7)
 *   - min_consecutive_work_days: ciclo mínimo (default 3)
 *   - min_rest_days / max_rest_days: descansos (default 2 / 4)
 *   - rest_after_max_stretch: descanso obligatorio tras un ciclo máximo
 *     (default 3)
 *   - min_hours_between_shifts: descanso entre turnos (default 12)
 *   - require_full_weekend_off_monthly: ≥1 finde sat+sun por mes (true)
 *
 * Prioridad en conflicto (más alta arriba):
 *   1. Reglas duras del convenio (12h, ciclo 3-7, descanso 2-4 + 3 post-7)
 *   2. Finde libre obligatorio por mes
 *   3. Cobertura mínima por turno
 *   4. Objetivo de horas anuales / 12 (±16h)
 *   5. Ciclos ideales 5-6, descanso ideal 2
 *
 * Fases internas:
 *   1. Demand model — calcula demanda diaria, capacidad y pre-flight.
 *   2. Rest plan — decide para cada empleado/día WORK|REST|OFF_REQUEST|
 *      WEEKEND_OFF coordinando entre empleados para evitar bloqueos
 *      sincronizados (causa raíz del bug histórico).
 *   3. Shift assignment — sobre los días marcados WORK, asigna M/T/N/P
 *      respetando especialistas, 12h y continuidad.
 */

const DEFAULT_CONVENTION: ConventionSettings = {
  max_consecutive_work_days: 7,
  min_consecutive_work_days: 3,
  min_rest_days: 2,
  max_rest_days: 4,
  rest_after_max_stretch: 3,
  min_hours_between_shifts: 12,
  require_full_weekend_off_monthly: true,
}

const HOURS_PER_SHIFT = 8
const DEFAULT_PARTIDO_START = 9
const HOURS_TOLERANCE = 16
/** Longitud ideal del ciclo (soft). El algoritmo tiende a 5-6. */
const IDEAL_STRETCH = 6
/** Descanso ideal entre ciclos (soft). */
const IDEAL_REST = 2
/** Próximo ciclo cap-ado tras alcanzar el máximo (soft, 5 por defecto). */
const STRETCH_AFTER_FULL = 5
/** Iteraciones máximas de la coordinación entre planes. */
const COORDINATION_MAX_PASSES = 20

export interface GenerateInput {
  monthISO: string
  employees: Employee[]
  approvedRequests: DayRequest[]
  holidays: PublicHoliday[]
  morningSlotsPerDay?: Record<string, number>
  carryOver?: Record<string, Shift[]>
  annualWorkHours?: number
  coverage?: {
    morning: { min: number; max: number | null }
    afternoon: { min: number; max: number | null }
    night: { min: number; max: number | null }
    partido: { min: number; max: number | null }
  }
  coverageOverrides?: CoverageOverride[]
  /** Convenio aplicable. Si no se pasa, se usa el default fijado en este
   *  módulo (espejo de DEFAULT_CONVENTION en db.ts). */
  convention?: ConventionSettings
}

const DEFAULT_COVERAGE = {
  morning: { min: 1, max: null as number | null },
  afternoon: { min: 1, max: 1 as number | null },
  night: { min: 0, max: 0 as number | null },
  partido: { min: 0, max: 0 as number | null },
}

export interface GenerateOutput {
  entries: Omit<ScheduleEntry, 'id' | 'schedule_id'>[]
  violations: Violation[]
}

export interface Violation {
  date: string
  kind:
    | 'no-morning-coverage'
    | 'no-afternoon-coverage'
    | 'short-stretch'
    | 'over-max-rest'
    | 'no-weekend-rest'
    | 'budget-deviation'
    | 'understaffed'
  detail: string
  employeeId?: string
}

type PlanState = 'work' | 'rest' | 'off-request' | 'weekend-off'

interface CarryStats {
  /** Días consecutivos trabajados al cierre del mes previo (0 si vino off). */
  stretchDay: number
  /** Días consecutivos off al cierre del mes previo. */
  consecutiveOff: number
  /** Longitud del último ciclo completo (para REST_AFTER_FULL). */
  lastStretchLength: number
  lastShift: Shift
}

interface ShiftBound {
  min: number
  max: number | null
}

interface DailyDemand {
  morning: ShiftBound
  afternoon: ShiftBound
  night: ShiftBound
  partido: ShiftBound
  /** Suma de mins, lo que tiene que cubrir el plan de descansos. */
  minTotal: number
  /** Demanda efectiva (puede crecer si hay capacidad sobrante con max=null). */
  maxTotal: number | null
}

const WORK_SHIFTS: WorkShift[] = ['morning', 'afternoon', 'night', 'partido']

// ─────────────────────────────────────────────────────────────
// Helpers genéricos
// ─────────────────────────────────────────────────────────────

function shiftAllowed(emp: Employee, shift: Shift): boolean {
  if (shift === 'off') return true
  if (!isWorkShift(shift)) return true
  return (emp.shifts ?? ['morning', 'afternoon']).includes(shift)
}

function shiftHours(
  shift: WorkShift,
  partidoStart: number = DEFAULT_PARTIDO_START,
): { start: number; end: number; endsNextDay: boolean } {
  switch (shift) {
    case 'morning':
      return { start: 7, end: 15, endsNextDay: false }
    case 'afternoon':
      return { start: 15, end: 23, endsNextDay: false }
    case 'night':
      return { start: 23, end: 7, endsNextDay: true }
    case 'partido': {
      const start = partidoStart
      const end = (start + HOURS_PER_SHIFT) % 24
      return { start, end, endsNextDay: start + HOURS_PER_SHIFT >= 24 }
    }
  }
}

function isWorkShift(s: Shift): s is WorkShift {
  return s === 'morning' || s === 'afternoon' || s === 'night' || s === 'partido'
}

/** Distancia en horas entre el fin de `prev` (día D) y el inicio de `next`
 *  (día D+1). Devuelve true si el gap ≥ `minGap`. */
function canTransition(
  prev: Shift,
  next: Shift,
  minGap: number,
  partidoStart: number = DEFAULT_PARTIDO_START,
): boolean {
  if (!isWorkShift(prev) || !isWorkShift(next)) return true
  const p = shiftHours(prev, partidoStart)
  const n = shiftHours(next, partidoStart)
  const prevEndAbs = (p.endsNextDay ? 24 : 0) + p.end
  const nextStartAbs = 24 + n.start
  return nextStartAbs - prevEndAbs >= minGap
}

function isOff(
  empId: string,
  dateISO: string,
  requests: DayRequest[],
): boolean {
  return requests.some(
    (r) =>
      r.employee_id === empId &&
      r.status === 'approved' &&
      dateISO >= r.start_date &&
      dateISO <= r.end_date,
  )
}

function approvedOffFor(
  empId: string,
  dateISO: string,
  requests: DayRequest[],
): DayRequest | null {
  return (
    requests.find(
      (r) =>
        r.employee_id === empId &&
        r.status === 'approved' &&
        dateISO >= r.start_date &&
        dateISO <= r.end_date,
    ) ?? null
  )
}

interface Weekend {
  satIdx: number
  sunIdx: number
  sat: string
  sun: string
}

function findWeekends(monthDays: Date[]): Weekend[] {
  const weekends: Weekend[] = []
  for (let i = 0; i < monthDays.length - 1; i++) {
    const d = monthDays[i]
    const next = monthDays[i + 1]
    if (d.getDay() === 6 && next.getDay() === 0) {
      weekends.push({
        satIdx: i,
        sunIdx: i + 1,
        sat: toISO(d),
        sun: toISO(next),
      })
    }
  }
  return weekends
}

function hasFullWeekendOffByRequest(
  empId: string,
  weekends: Weekend[],
  requests: DayRequest[],
): boolean {
  for (const w of weekends) {
    const satOff = requests.some(
      (r) =>
        r.employee_id === empId &&
        r.status === 'approved' &&
        w.sat >= r.start_date &&
        w.sat <= r.end_date,
    )
    const sunOff = requests.some(
      (r) =>
        r.employee_id === empId &&
        r.status === 'approved' &&
        w.sun >= r.start_date &&
        w.sun <= r.end_date,
    )
    if (satOff && sunOff) return true
  }
  return false
}

// ─────────────────────────────────────────────────────────────
// Carry-over
// ─────────────────────────────────────────────────────────────

function makeFreshCarry(convention: ConventionSettings): CarryStats {
  return {
    stretchDay: 0,
    consecutiveOff: convention.min_rest_days,
    lastStretchLength: 0,
    lastShift: 'off',
  }
}

function readCarryStats(
  recent: Shift[],
  convention: ConventionSettings,
): CarryStats {
  if (recent.length === 0) return makeFreshCarry(convention)
  const last = recent[recent.length - 1]
  if (last === 'off' || !isWorkShift(last)) {
    let off = 0
    for (let i = recent.length - 1; i >= 0 && !isWorkShift(recent[i]); i--) off++
    let stretchLen = 0
    for (let i = recent.length - 1 - off; i >= 0 && isWorkShift(recent[i]); i--) {
      stretchLen++
    }
    return {
      stretchDay: 0,
      consecutiveOff: off,
      lastStretchLength: stretchLen,
      lastShift: last,
    }
  }
  let day = 0
  for (let i = recent.length - 1; i >= 0 && isWorkShift(recent[i]); i--) day++
  return {
    stretchDay: day,
    consecutiveOff: 0,
    lastStretchLength: day,
    lastShift: last,
  }
}

// ─────────────────────────────────────────────────────────────
// Fase 1: Demanda
// ─────────────────────────────────────────────────────────────

function buildDailyDemand(
  daysISO: string[],
  coverage: NonNullable<GenerateInput['coverage']>,
  overrides: CoverageOverride[],
): DailyDemand[] {
  return daysISO.map((dISO) => {
    const out: Partial<DailyDemand> = { minTotal: 0, maxTotal: 0 }
    let minTotal = 0
    let maxTotalGrowable = false
    let maxTotalKnown = 0
    for (const shift of WORK_SHIFTS) {
      const o = overrides.find(
        (x) => x.shift === shift && dISO >= x.start_date && dISO <= x.end_date,
      )
      const base = coverage[shift]
      const min = o && o.min !== null && o.min !== undefined ? o.min : base.min
      const max =
        o && o.max !== undefined && o.max !== null
          ? o.max
          : o && o.max === null
            ? null
            : base.max
      out[shift] = { min, max }
      minTotal += min
      if (max === null) maxTotalGrowable = true
      else maxTotalKnown += max
    }
    return {
      morning: out.morning!,
      afternoon: out.afternoon!,
      night: out.night!,
      partido: out.partido!,
      minTotal,
      maxTotal: maxTotalGrowable ? null : maxTotalKnown,
    }
  })
}

/** Para cada día, cuántos empleados están disponibles (no en off aprobado). */
function buildDailyAvailability(
  employees: Employee[],
  daysISO: string[],
  allOffs: DayRequest[],
): number[] {
  return daysISO.map((d) => {
    let n = 0
    for (const e of employees) if (!isOff(e.id, d, allOffs)) n++
    return n
  })
}

// ─────────────────────────────────────────────────────────────
// Fase 2: Plan de descansos
// ─────────────────────────────────────────────────────────────

interface PlanContext {
  daysISO: string[]
  weekends: Weekend[]
  demand: DailyDemand[]
  convention: ConventionSettings
  allOffs: DayRequest[]
  /** Para cada empleado, su array de PlanState (longitud = daysISO.length). */
  plans: Map<string, PlanState[]>
  /** Para cada empleado, el índice del finde libre asignado (-1 si no
   *  tiene weekend sintético — ya viene con request aprobado o no entró). */
  weekendIdx: Map<string, number>
  carry: Map<string, CarryStats>
}

function planIsWork(s: PlanState | undefined): boolean {
  return s === 'work'
}

/** ¿Hay un día con estado fijo (off-request, weekend-off) dentro de los
 *  próximos `len` días desde `d`? Si lo hay, iniciar un stretch ahora
 *  resultaría en un ciclo más corto de lo permitido. Si `d+len` excede el
 *  mes, asumimos que el stretch puede continuar en el mes siguiente. */
function canStartStretch(
  fixed: (PlanState | null)[],
  d: number,
  len: number,
): boolean {
  const N = fixed.length
  for (let i = 0; i < len; i++) {
    const di = d + i
    if (di >= N) return true
    if (fixed[di] !== null) return false
  }
  return true
}

/** Genera un plan personal greedy partiendo de los días con estado fijo
 *  (off-request, weekend-off) y aplicando reglas duras + soft.
 *  `delayDays` fuerza N días de rest al inicio (staggering) si el carry
 *  lo permite. */
function generatePersonalPlan(
  emp: Employee,
  carry: CarryStats,
  fixed: (PlanState | null)[],
  convention: ConventionSettings,
  delayDays: number,
): PlanState[] {
  const N = fixed.length
  const plan: PlanState[] = new Array(N)
  let stretchDay = carry.stretchDay
  let restDay = carry.consecutiveOff
  let lastStretchLen = carry.lastStretchLength
  let delayLeft = stretchDay > 0 ? 0 : delayDays
  void emp

  for (let d = 0; d < N; d++) {
    if (fixed[d] !== null) {
      plan[d] = fixed[d]!
      if (stretchDay > 0) {
        lastStretchLen = stretchDay
        stretchDay = 0
      }
      restDay += 1
      continue
    }

    const minR =
      lastStretchLen >= convention.max_consecutive_work_days
        ? convention.rest_after_max_stretch
        : convention.min_rest_days
    const maxR =
      lastStretchLen >= convention.max_consecutive_work_days
        ? convention.rest_after_max_stretch
        : convention.max_rest_days
    const maxS =
      lastStretchLen >= convention.max_consecutive_work_days
        ? Math.min(STRETCH_AFTER_FULL, convention.max_consecutive_work_days)
        : convention.max_consecutive_work_days

    let decision: 'work' | 'rest'
    if (stretchDay >= maxS) {
      decision = 'rest'
    } else if (stretchDay >= 1 && stretchDay < convention.min_consecutive_work_days) {
      decision = 'work'
    } else if (stretchDay === 0 && restDay < minR) {
      decision = 'rest'
    } else if (stretchDay === 0 && restDay >= maxR) {
      // Forzado a empezar aunque luego rompa stretch — el max rest gana.
      decision = 'work'
    } else if (stretchDay >= 1 && stretchDay >= IDEAL_STRETCH) {
      decision = 'rest'
    } else if (stretchDay >= 1) {
      decision = 'work'
    } else if (delayLeft > 0) {
      decision = 'rest'
      delayLeft -= 1
    } else if (restDay >= IDEAL_REST) {
      // Lookahead: sólo iniciar el stretch si los próximos
      // `min_consecutive_work_days` días están libres de fixed-off,
      // para no terminar con un ciclo corto que viole MIN_STRETCH.
      if (canStartStretch(fixed, d, convention.min_consecutive_work_days)) {
        decision = 'work'
      } else {
        decision = 'rest'
      }
    } else {
      decision = 'rest'
    }


    plan[d] = decision
    if (decision === 'work') {
      stretchDay = stretchDay >= 1 ? stretchDay + 1 : 1
      restDay = 0
    } else {
      if (stretchDay > 0) {
        lastStretchLen = stretchDay
        stretchDay = 0
      }
      restDay += 1
    }
  }
  return plan
}

/** Cuántas variantes con offset inicial probamos al elegir el plan que
 *  mejor distribuye la demanda. */
function offsetCandidates(convention: ConventionSettings): number[] {
  // 0..max_rest_days-1 cubre todos los desfases razonables sin violar
  // el descanso máximo.
  const out: number[] = []
  for (let i = 0; i <= convention.max_rest_days - convention.min_rest_days; i++) {
    out.push(i)
  }
  return out
}

/** Suma cuántos días el plan deja sin cubrir respecto a la demanda mínima
 *  + cuántos días sobre-cubre respecto a la demanda máxima conocida.
 *  Cuanto menor, mejor. */
function planScore(
  plan: PlanState[],
  workCountSoFar: number[],
  demand: DailyDemand[],
): number {
  let score = 0
  for (let d = 0; d < plan.length; d++) {
    const work = (planIsWork(plan[d]) ? 1 : 0) + workCountSoFar[d]
    if (work < demand[d].minTotal) {
      // Penalizar fuerte los días con shortage residual.
      score += (demand[d].minTotal - work) * 100
    }
    const maxTotal = demand[d].maxTotal
    if (maxTotal !== null && work > maxTotal) {
      score += (work - maxTotal) * 10
    }
  }
  return score
}

/** Asigna findes libres sintéticos garantizando capacidad. Cuando no
 *  alcanza, prioriza dar finde a tantos empleados como sea posible. */
function assignWeekendOffs(
  employees: Employee[],
  weekends: Weekend[],
  approvedRequests: DayRequest[],
  daysISO: string[],
  demand: DailyDemand[],
  availability: number[],
): { weekendIdx: Map<string, number>; synthetic: DayRequest[]; missing: Employee[] } {
  const weekendIdx = new Map<string, number>()
  const synthetic: DayRequest[] = []
  const missing: Employee[] = []
  if (weekends.length === 0) {
    return { weekendIdx, synthetic, missing: employees.slice() }
  }

  const need = employees.filter(
    (e) => !hasFullWeekendOffByRequest(e.id, weekends, approvedRequests),
  )

  // Capacidad de cada finde: empleados disponibles − minTotal demanda. El
  // mínimo entre sat y sun manda — no podemos dejar al empleado libre un
  // solo día.
  const weekendCapacity = weekends.map((w) => {
    const idxSat = daysISO.indexOf(w.sat)
    const idxSun = daysISO.indexOf(w.sun)
    if (idxSat === -1 || idxSun === -1) return 0
    const surplusSat = availability[idxSat] - demand[idxSat].minTotal
    const surplusSun = availability[idxSun] - demand[idxSun].minTotal
    return Math.max(0, Math.min(surplusSat, surplusSun))
  })

  // Especialistas (un solo turno) primero — son los más constreñidos.
  const ordered = [...need].sort((a, b) => {
    const sa = (a.shifts ?? ['morning', 'afternoon']).length > 1 ? 1 : 0
    const sb = (b.shifts ?? ['morning', 'afternoon']).length > 1 ? 1 : 0
    return sa - sb
  })

  const perWeekend: number[] = weekends.map(() => 0)
  for (const e of ordered) {
    let bestIdx = -1
    for (let i = 0; i < weekends.length; i++) {
      if (perWeekend[i] >= weekendCapacity[i]) continue
      if (bestIdx === -1 || perWeekend[i] < perWeekend[bestIdx]) bestIdx = i
    }
    if (bestIdx === -1) {
      missing.push(e)
      continue
    }
    perWeekend[bestIdx]++
    weekendIdx.set(e.id, bestIdx)
    const w = weekends[bestIdx]
    synthetic.push({
      id: `weekend-off-${e.id}-${w.sat}`,
      employee_id: e.id,
      type: 'personal',
      start_date: w.sat,
      end_date: w.sun,
      status: 'approved',
      target_month: daysISO[0],
    })
  }
  return { weekendIdx, synthetic, missing }
}

/** Coordina los planes individuales: detecta días con shortage o excess y
 *  hace pequeños ajustes (mover descansos ±1 día) para mejorar el global. */
function coordinatePlans(ctx: PlanContext, employees: Employee[]): void {
  const N = ctx.daysISO.length
  const workCount = new Array(N).fill(0)
  for (const plan of ctx.plans.values()) {
    for (let d = 0; d < N; d++) if (planIsWork(plan[d])) workCount[d]++
  }

  for (let pass = 0; pass < COORDINATION_MAX_PASSES; pass++) {
    let changed = false
    for (let d = 0; d < N; d++) {
      const need = ctx.demand[d].minTotal
      if (workCount[d] >= need) continue
      const deficit = need - workCount[d]
      // Buscar empleados en REST hoy a los que podamos mover el descanso
      // un día (atrás o adelante) sin romper reglas duras ni crear shortage
      // en el nuevo día de descanso.
      for (let i = 0; i < deficit; i++) {
        const moved = tryFillShortage(ctx, employees, d, workCount)
        if (moved) {
          changed = true
        } else {
          break
        }
      }
    }
    if (!changed) break
  }
}

/** Convierte el rest del empleado el día d en work moviendo su rest a
 *  un día adyacente. Devuelve true si lo logró. */
function tryFillShortage(
  ctx: PlanContext,
  employees: Employee[],
  d: number,
  workCount: number[],
): boolean {
  const N = ctx.daysISO.length
  // Candidates: empleados en REST el día d.
  const candidates: { emp: Employee; targetDay: number }[] = []
  for (const e of employees) {
    const plan = ctx.plans.get(e.id)!
    if (plan[d] !== 'rest') continue
    // Tenemos que mover el rest a otro día. Probar d-1 y d+1.
    for (const td of [d + 1, d - 1]) {
      if (td < 0 || td >= N) continue
      if (plan[td] !== 'work') continue
      // Verificar que el swap respeta reglas: hacemos work el día d y
      // rest el día td. Validamos el plan completo del empleado.
      if (canSwapWorkRest(plan, d, td, ctx.carry.get(e.id)!, ctx.convention)) {
        // El nuevo día de rest no debe causar shortage en otro día.
        if (workCount[td] - 1 >= ctx.demand[td].minTotal) {
          candidates.push({ emp: e, targetDay: td })
        }
      }
    }
  }
  if (candidates.length === 0) return false
  // Preferir mover a empleados multi-shift sobre especialistas (más
  // flexibilidad de cobertura en fase 3) y mover hacia adelante antes que
  // hacia atrás (menos perturba el carry-over).
  candidates.sort((a, b) => {
    const sa = (a.emp.shifts ?? ['morning', 'afternoon']).length
    const sb = (b.emp.shifts ?? ['morning', 'afternoon']).length
    if (sa !== sb) return sb - sa
    return a.targetDay - b.targetDay
  })
  const pick = candidates[0]
  const plan = ctx.plans.get(pick.emp.id)!
  plan[d] = 'work'
  plan[pick.targetDay] = 'rest'
  workCount[d]++
  workCount[pick.targetDay]--
  return true
}

/** Simula un swap (rest en d ↔ work en td) y verifica reglas duras
 *  recorriendo el plan resultante. */
function canSwapWorkRest(
  plan: PlanState[],
  d: number,
  td: number,
  carry: CarryStats,
  convention: ConventionSettings,
): boolean {
  // Construir variante temporal.
  const tmp = plan.slice()
  tmp[d] = 'work'
  tmp[td] = 'rest'
  return validatePlan(tmp, carry, convention)
}

/** Recorre un plan completo desde el carry-over y verifica que ninguna
 *  transición viole reglas duras. Los rest forzados (off-request,
 *  weekend-off) son inviolables: no fallan la validación aunque corten
 *  un stretch o extiendan un rest más allá del máximo. */
function validatePlan(
  plan: PlanState[],
  carry: CarryStats,
  convention: ConventionSettings,
): boolean {
  let stretchDay = carry.stretchDay
  let restDay = carry.consecutiveOff
  let lastStretchLen = carry.lastStretchLength

  for (let d = 0; d < plan.length; d++) {
    const state = plan[d]
    if (state === 'work') {
      const minR =
        lastStretchLen >= convention.max_consecutive_work_days
          ? convention.rest_after_max_stretch
          : convention.min_rest_days
      if (stretchDay === 0 && restDay < minR) return false
      const maxS =
        lastStretchLen >= convention.max_consecutive_work_days
          ? Math.min(STRETCH_AFTER_FULL, convention.max_consecutive_work_days)
          : convention.max_consecutive_work_days
      if (stretchDay >= maxS) return false
      stretchDay = stretchDay >= 1 ? stretchDay + 1 : 1
      restDay = 0
    } else {
      // Para REST algorítmico aplicamos ambas reglas. Para off-request y
      // weekend-off (forzados) sólo actualizamos contadores.
      if (state === 'rest') {
        if (stretchDay >= 1 && stretchDay < convention.min_consecutive_work_days) {
          return false
        }
        const maxR =
          lastStretchLen >= convention.max_consecutive_work_days
            ? convention.rest_after_max_stretch
            : convention.max_rest_days
        if (stretchDay === 0 && restDay >= maxR) return false
      }
      if (stretchDay > 0) {
        lastStretchLen = stretchDay
        stretchDay = 0
      }
      restDay += 1
    }
  }
  return true
}

// ─────────────────────────────────────────────────────────────
// Fase 3: Asignación de turno
// ─────────────────────────────────────────────────────────────

interface ShiftAssignmentResult {
  entries: Omit<ScheduleEntry, 'id' | 'schedule_id'>[]
  violations: Violation[]
  /** Por empleado: stats finales para el control de horas anuales. */
  workCounts: Map<string, number>
}

function assignShifts(
  ctx: PlanContext,
  employees: Employee[],
  approvedRequests: DayRequest[],
): ShiftAssignmentResult {
  const entries: Omit<ScheduleEntry, 'id' | 'schedule_id'>[] = []
  const violations: Violation[] = []
  const workCounts = new Map<string, number>()
  for (const e of employees) workCounts.set(e.id, 0)
  // lastShift por empleado (para la regla 12h dentro del mes)
  const lastShift = new Map<string, Shift>()
  for (const e of employees) lastShift.set(e.id, ctx.carry.get(e.id)!.lastShift)
  // Totales por turno para balance.
  const totalByShift = new Map<string, Record<WorkShift, number>>()
  for (const e of employees) {
    totalByShift.set(e.id, { morning: 0, afternoon: 0, night: 0, partido: 0 })
  }
  // Stretch tracking dentro del mes para violations.
  const stretchDay = new Map<string, number>()
  const consecutiveOff = new Map<string, number>()
  for (const e of employees) {
    const c = ctx.carry.get(e.id)!
    stretchDay.set(e.id, c.stretchDay)
    consecutiveOff.set(e.id, c.consecutiveOff)
  }
  const weekendOffSeen = new Map<string, boolean>()
  for (const e of employees) {
    const idx = ctx.weekendIdx.get(e.id)
    if (idx === undefined || idx < 0) {
      // El empleado puede tener finde por request aprobado — chequear.
      weekendOffSeen.set(
        e.id,
        hasFullWeekendOffByRequest(e.id, ctx.weekends, approvedRequests),
      )
    } else {
      weekendOffSeen.set(e.id, true)
    }
  }

  for (let d = 0; d < ctx.daysISO.length; d++) {
    const dISO = ctx.daysISO[d]
    const dailyAssignment = new Map<string, Shift>()
    const dailyAssignmentSource = new Map<string, 'auto' | 'request'>()

    // 1. Aplicar off-request reales y weekend-off sintéticos.
    for (const e of employees) {
      const plan = ctx.plans.get(e.id)!
      const state = plan[d]
      if (state === 'off-request') {
        const req = approvedOffFor(e.id, dISO, approvedRequests)
        if (req) {
          dailyAssignment.set(e.id, req.type as Shift)
          dailyAssignmentSource.set(e.id, 'request')
        } else {
          dailyAssignment.set(e.id, 'off')
          dailyAssignmentSource.set(e.id, 'auto')
        }
      } else if (state === 'weekend-off') {
        dailyAssignment.set(e.id, 'off')
        dailyAssignmentSource.set(e.id, 'auto')
      } else if (state === 'rest') {
        dailyAssignment.set(e.id, 'off')
        dailyAssignmentSource.set(e.id, 'auto')
      }
      // 'work' se resuelve abajo
    }

    // 2. Asignar turnos a los empleados con 'work'.
    const workEmps = employees.filter((e) => ctx.plans.get(e.id)![d] === 'work')

    // Asignar primero los turnos restringidos: afternoon, night, partido.
    // Morning queda al final porque suele ser el menos restringido.
    for (const shift of ['afternoon', 'night', 'partido', 'morning'] as WorkShift[]) {
      const dem = ctx.demand[d][shift]
      if (dem.min <= 0 && dem.max === 0) continue
      let placed = 0
      // Contar ya asignados (caso raro: nada hasta acá).
      for (const e of employees) {
        if (dailyAssignment.get(e.id) === shift) placed++
      }
      while (true) {
        if (dem.max !== null && placed >= dem.max) break
        // Mientras estemos bajo el mínimo, intentamos colocar a alguien
        // aunque tengamos que tirar de un 'rest' planeado (urgente).
        const urgent = placed < dem.min
        const pick = pickShiftCandidate(
          shift,
          workEmps,
          employees,
          dailyAssignment,
          lastShift,
          totalByShift,
          ctx.convention,
          urgent,
        )
        if (!pick) break
        dailyAssignment.set(pick.id, shift)
        dailyAssignmentSource.set(pick.id, 'auto')
        placed++
        // Si vino de rest urgente, su plan también cambia: lo registramos
        // para que stretchDay/consecutiveOff se actualice correctamente.
        if (ctx.plans.get(pick.id)![d] !== 'work') {
          ctx.plans.get(pick.id)![d] = 'work'
        }
      }
      // Pasar excedentes opcionales (morning sin tope con tier 0/1 forzados).
      // Eso lo manejamos al final si quedan workEmps sin turno asignado.
      if (placed < dem.min) {
        violations.push({
          date: dISO,
          kind: shift === 'morning' ? 'no-morning-coverage' : 'no-afternoon-coverage',
          detail: `Cobertura insuficiente de ${shiftLabel(shift)} el ${dISO} (${placed}/${dem.min})`,
        })
      }
    }

    // 3. Empleados con 'work' que aún no recibieron turno: probar
    // colocarlos en algún turno respetando 12h, en orden de preferencia
    // (continuity, growable, otros). Si todo falla, último recurso es
    // exceder el max de la categoría — preferible a romper el plan
    // (que causaría short-stretch en fase 2).
    for (const e of workEmps) {
      if (dailyAssignment.has(e.id)) continue
      const last = lastShift.get(e.id) ?? 'off'
      const partidoStart = e.partido_start_hour ?? DEFAULT_PARTIDO_START
      // Orden de prueba: turno donde tiene continuidad → morning
      // (growable por defecto) → cualquier otro que permita 12h.
      const order: WorkShift[] = []
      if (isWorkShift(last) && shiftAllowed(e, last)) order.push(last)
      for (const s of ['morning', 'afternoon', 'night', 'partido'] as WorkShift[]) {
        if (!order.includes(s) && shiftAllowed(e, s)) order.push(s)
      }
      let placed: WorkShift | null = null
      // Primera pasada: respetando max actual de la categoría.
      for (const s of order) {
        const dem = ctx.demand[d][s]
        const current = [...dailyAssignment.values()].filter((x) => x === s).length
        if (dem.max !== null && current >= dem.max) continue
        if (!canTransition(last, s, ctx.convention.min_hours_between_shifts, partidoStart))
          continue
        placed = s
        break
      }
      // Segunda pasada: si nada cupo dentro del max, aceptar
      // over-coverage (mejor que romper el plan).
      if (!placed) {
        for (const s of order) {
          if (!canTransition(last, s, ctx.convention.min_hours_between_shifts, partidoStart))
            continue
          placed = s
          break
        }
      }
      if (placed) {
        dailyAssignment.set(e.id, placed)
        dailyAssignmentSource.set(e.id, 'auto')
      } else {
        // Sin ningún turno transitable — sólo aquí pasamos a off y
        // ajustamos el plan (la regla 12h convirtió el día en
        // inevitable rest).
        dailyAssignment.set(e.id, 'off')
        dailyAssignmentSource.set(e.id, 'auto')
        ctx.plans.get(e.id)![d] = 'rest'
      }
    }

    // 4. Emitir entries + actualizar stats.
    for (const e of employees) {
      const final: Shift = dailyAssignment.get(e.id) ?? 'off'
      const src = dailyAssignmentSource.get(e.id) ?? 'auto'
      entries.push({
        employee_id: e.id,
        date: dISO,
        shift: final,
        source: src,
      })
      if (isWorkShift(final)) {
        workCounts.set(e.id, (workCounts.get(e.id) ?? 0) + 1)
        const tot = totalByShift.get(e.id)!
        tot[final] += 1
        lastShift.set(e.id, final)
        stretchDay.set(e.id, (stretchDay.get(e.id) ?? 0) + 1)
        consecutiveOff.set(e.id, 0)
        // Si es weekend (sat o sun) y forma parte de un finde, marcamos
        // que NO tuvo finde libre aún.
        // Manejado abajo por weekendOffSeen.
      } else {
        const sd = stretchDay.get(e.id) ?? 0
        if (sd > 0 && sd < ctx.convention.min_consecutive_work_days) {
          // Sólo violation si NO fue causado por un off forzado
          // (request real del empleado o weekend-off algorítmico).
          const planState = ctx.plans.get(e.id)![d]
          const forced =
            planState === 'off-request' || planState === 'weekend-off'
          if (!forced) {
            violations.push({
              date: dISO,
              kind: 'short-stretch',
              employeeId: e.id,
              detail: `${e.full_name} terminó un ciclo de solo ${sd} día(s) — mínimo ${ctx.convention.min_consecutive_work_days}`,
            })
          }
        }
        stretchDay.set(e.id, 0)
        consecutiveOff.set(e.id, (consecutiveOff.get(e.id) ?? 0) + 1)
        lastShift.set(e.id, 'off')
      }
    }
  }

  // 5. Violations: empleados sin finde libre (regla dura).
  for (const e of employees) {
    if (!weekendOffSeen.get(e.id)) {
      violations.push({
        date: ctx.daysISO[0],
        kind: 'no-weekend-rest',
        employeeId: e.id,
        detail: `${e.full_name} no tiene ningún fin de semana completo de descanso este mes`,
      })
    }
  }

  return { entries, violations, workCounts }
}

function shiftLabel(s: WorkShift): string {
  return s === 'morning'
    ? 'mañana'
    : s === 'afternoon'
      ? 'tarde'
      : s === 'night'
        ? 'noche'
        : 'partido'
}

function pickShiftCandidate(
  shift: WorkShift,
  workEmps: Employee[],
  allEmployees: Employee[],
  dailyAssignment: Map<string, Shift>,
  lastShift: Map<string, Shift>,
  totalByShift: Map<string, Record<WorkShift, number>>,
  convention: ConventionSettings,
  urgent: boolean,
): Employee | null {
  // Candidatos: empleados con 'work' planeado todavía sin asignar.
  let pool = workEmps.filter(
    (e) => !dailyAssignment.has(e.id) && shiftAllowed(e, shift),
  )
  pool = pool.filter((e) =>
    canTransition(
      lastShift.get(e.id) ?? 'off',
      shift,
      convention.min_hours_between_shifts,
      e.partido_start_hour ?? DEFAULT_PARTIDO_START,
    ),
  )
  if (pool.length === 0 && urgent) {
    // Tirar de un 'rest' planeado que cumpla reglas duras.
    pool = allEmployees.filter(
      (e) => !dailyAssignment.has(e.id) && shiftAllowed(e, shift),
    )
    pool = pool.filter((e) =>
      canTransition(
        lastShift.get(e.id) ?? 'off',
        shift,
        convention.min_hours_between_shifts,
        e.partido_start_hour ?? DEFAULT_PARTIDO_START,
      ),
    )
  }
  if (pool.length === 0) return null

  pool.sort((a, b) => {
    const aS = (a.shifts ?? ['morning', 'afternoon']).length === 1 ? 0 : 1
    const bS = (b.shifts ?? ['morning', 'afternoon']).length === 1 ? 0 : 1
    if (aS !== bS) return aS - bS // especialista del turno gana
    const aCont = lastShift.get(a.id) === shift ? 0 : 1
    const bCont = lastShift.get(b.id) === shift ? 0 : 1
    if (aCont !== bCont) return aCont - bCont
    const aT = totalByShift.get(a.id)![shift]
    const bT = totalByShift.get(b.id)![shift]
    if (aT !== bT) return aT - bT // balance por turno
    return 0
  })
  return pool[0]
}

// ─────────────────────────────────────────────────────────────
// Entry point
// ─────────────────────────────────────────────────────────────

export function generateSchedule(input: GenerateInput): GenerateOutput {
  const convention = input.convention ?? DEFAULT_CONVENTION
  const coverage = input.coverage ?? DEFAULT_COVERAGE
  const overrides = input.coverageOverrides ?? []

  const monthDate = fromISO(input.monthISO)
  const days = eachDayInMonth(monthDate)
  const daysISO = days.map(toISO)
  const N = days.length

  // Carry-over por empleado
  const carry = new Map<string, CarryStats>()
  for (const e of input.employees) {
    const recent = input.carryOver?.[e.id] ?? []
    carry.set(e.id, readCarryStats(recent, convention))
  }

  // Fase 1: demanda + disponibilidad
  const demand = buildDailyDemand(daysISO, coverage, overrides)
  const weekends = findWeekends(days)
  const availability = buildDailyAvailability(
    input.employees,
    daysISO,
    input.approvedRequests,
  )

  // Pre-flight check: ¿la plantilla es suficiente?
  const violations: Violation[] = []
  let totalDemand = 0
  let totalCapacity = 0
  for (let d = 0; d < N; d++) {
    totalDemand += demand[d].minTotal
    totalCapacity += availability[d]
    if (availability[d] < demand[d].minTotal) {
      violations.push({
        date: daysISO[d],
        kind: 'understaffed',
        detail: `Plantilla insuficiente el ${daysISO[d]}: ${availability[d]} disponibles vs ${demand[d].minTotal} requeridos`,
      })
    }
  }
  if (
    totalDemand > totalCapacity &&
    !violations.some((v) => v.kind === 'understaffed')
  ) {
    violations.push({
      date: input.monthISO,
      kind: 'understaffed',
      detail: `Plantilla insuficiente este mes: ${totalDemand} turnos requeridos vs ${totalCapacity} persona-días disponibles`,
    })
  }

  // Asignar findes libres sintéticos
  const { weekendIdx, synthetic, missing } = assignWeekendOffs(
    input.employees,
    weekends,
    input.approvedRequests,
    daysISO,
    demand,
    availability,
  )
  for (const e of missing) {
    if (convention.require_full_weekend_off_monthly) {
      // El violation se emite al final de fase 3 si efectivamente no
      // tuvo finde libre, así que acá sólo marcamos en weekendIdx.
    }
    weekendIdx.set(e.id, -1)
  }
  const allOffs: DayRequest[] = [...input.approvedRequests, ...synthetic]

  // Fase 2: plan inicial por empleado, con búsqueda de mejor offset
  const plans = new Map<string, PlanState[]>()

  // Pre-armar el array de estados fijos por empleado
  const fixedByEmp = new Map<string, (PlanState | null)[]>()
  for (const e of input.employees) {
    const fixed: (PlanState | null)[] = new Array(N).fill(null)
    for (let d = 0; d < N; d++) {
      if (isOff(e.id, daysISO[d], input.approvedRequests)) {
        fixed[d] = 'off-request'
      }
    }
    const wi = weekendIdx.get(e.id)
    if (wi !== undefined && wi >= 0) {
      const w = weekends[wi]
      fixed[w.satIdx] = 'weekend-off'
      fixed[w.sunIdx] = 'weekend-off'
    }
    fixedByEmp.set(e.id, fixed)
  }

  // Para minimizar shortage, procesamos primero los empleados con menos
  // flexibilidad (mid-stretch o mid-rest forzado), después los frescos.
  // Para frescos, probamos varios offsets y elegimos el que mejor encaja
  // con la demanda acumulada hasta el momento.
  const empOrder = [...input.employees].sort((a, b) => {
    const ca = carry.get(a.id)!
    const cb = carry.get(b.id)!
    const flex = (c: CarryStats) => {
      if (c.stretchDay > 0) return 0 // mid-stretch: 0 flexibilidad
      if (c.consecutiveOff < convention.min_rest_days) return 1
      return 2
    }
    const fa = flex(ca)
    const fb = flex(cb)
    if (fa !== fb) return fa - fb
    return a.id.localeCompare(b.id)
  })

  const workCountSoFar = new Array(N).fill(0)
  for (const e of empOrder) {
    const fixed = fixedByEmp.get(e.id)!
    const baseCarry = carry.get(e.id)!
    let bestPlan: PlanState[] | null = null
    let bestScore = Infinity
    // Para frescos probamos distintos `delayDays` (rest forzado al
    // inicio) para staggering. Mid-stretch o mid-rest forzado: sin delay.
    const delayOptions =
      baseCarry.stretchDay > 0 ||
      baseCarry.consecutiveOff < convention.min_rest_days
        ? [0]
        : offsetCandidates(convention)
    for (const delay of delayOptions) {
      // No agregar tanto delay que el consecutiveOff inicial supere el
      // max permitido (regla dura).
      const maxR =
        baseCarry.lastStretchLength >= convention.max_consecutive_work_days
          ? convention.rest_after_max_stretch
          : convention.max_rest_days
      if (baseCarry.consecutiveOff + delay > maxR) continue
      const plan = generatePersonalPlan(e, baseCarry, fixed, convention, delay)
      if (!validatePlan(plan, baseCarry, convention)) continue
      const sc = planScore(plan, workCountSoFar, demand)
      if (sc < bestScore) {
        bestScore = sc
        bestPlan = plan
      }
    }
    if (!bestPlan) {
      bestPlan = generatePersonalPlan(e, baseCarry, fixed, convention, 0)
    }
    plans.set(e.id, bestPlan)
    for (let d = 0; d < N; d++) if (planIsWork(bestPlan[d])) workCountSoFar[d]++
  }

  // Coordinación: ajustar planes para mejorar cobertura global.
  const ctx: PlanContext = {
    daysISO,
    weekends,
    demand,
    convention,
    allOffs,
    plans,
    weekendIdx,
    carry,
  }
  coordinatePlans(ctx, input.employees)


  // Fase 3: asignación de turno
  const phase3 = assignShifts(ctx, input.employees, input.approvedRequests)
  violations.push(...phase3.violations)

  // Control de horas anuales (warning blando)
  if (input.annualWorkHours && input.annualWorkHours > 0) {
    const monthlyBaseline = input.annualWorkHours / 12
    const monthDays = N
    for (const e of input.employees) {
      const worked = phase3.workCounts.get(e.id) ?? 0
      const workedHours = worked * HOURS_PER_SHIFT
      const offRequestDays = phase3.entries.filter(
        (x) =>
          x.employee_id === e.id &&
          (x.shift === 'vacation' ||
            x.shift === 'holiday' ||
            x.shift === 'personal' ||
            x.shift === 'sick'),
      ).length
      const adjustedTarget =
        monthlyBaseline * ((monthDays - offRequestDays) / monthDays)
      const deviation = workedHours - adjustedTarget
      if (Math.abs(deviation) > HOURS_TOLERANCE) {
        violations.push({
          date: input.monthISO,
          kind: 'budget-deviation',
          employeeId: e.id,
          detail: `${e.full_name}: ${workedHours} h este mes (objetivo ${adjustedTarget.toFixed(0)} h ± ${HOURS_TOLERANCE}, desviación ${deviation > 0 ? '+' : ''}${deviation.toFixed(0)} h)`,
        })
      }
    }
  }

  // Over-max-rest warnings (recorrer entries + carry-over)
  for (const e of input.employees) {
    let restRun = carry.get(e.id)!.consecutiveOff
    let lastStretchLen = carry.get(e.id)!.lastStretchLength
    let stretchRun = carry.get(e.id)!.stretchDay
    const maxRForCarry = (lsl: number) =>
      lsl >= convention.max_consecutive_work_days
        ? convention.rest_after_max_stretch
        : convention.max_rest_days
    for (const x of phase3.entries) {
      if (x.employee_id !== e.id) continue
      if (isWorkShift(x.shift)) {
        stretchRun = stretchRun >= 1 ? stretchRun + 1 : 1
        restRun = 0
      } else {
        if (stretchRun > 0) {
          lastStretchLen = stretchRun
          stretchRun = 0
        }
        restRun += 1
        const myMax = maxRForCarry(lastStretchLen)
        if (restRun === myMax + 1 && x.source !== 'request') {
          violations.push({
            date: x.date,
            kind: 'over-max-rest',
            employeeId: e.id,
            detail: `${e.full_name} supera los ${myMax} días de descanso a partir del ${x.date}`,
          })
        }
      }
    }
  }

  return { entries: phase3.entries, violations }
}

export function carryOverFromEntries(
  prevMonthEntries: Pick<ScheduleEntry, 'employee_id' | 'date' | 'shift'>[],
  monthISO: string,
): Record<string, Shift[]> {
  // Tomamos los últimos 14 días del mes previo: suficiente para ver el
  // último ciclo completo (≤7) + descanso (≤4) y un margen.
  const start = addDays(fromISO(monthISO), -14)
  const startISO = toISO(start)
  const filtered = prevMonthEntries
    .filter((e) => e.date >= startISO && e.date < monthISO)
    .sort((a, b) => a.date.localeCompare(b.date))
  const grouped: Record<string, Shift[]> = {}
  for (const e of filtered) {
    if (!grouped[e.employee_id]) grouped[e.employee_id] = []
    // Vacation/holiday/personal cuentan como 'off' a efectos de
    // stretch/rest. Mantenemos morning/afternoon/night/partido tal cual
    // para que la regla 12h en day 1 del mes nuevo lea el último turno.
    const normalised: Shift = isWorkShift(e.shift) ? e.shift : 'off'
    grouped[e.employee_id].push(normalised)
  }
  return grouped
}

// (compat) Función exportada en versiones previas. Mantener export para
// no romper imports externos que pudieran hacer referencia.
export function isLastDay(day: Date, days: Date[]): boolean {
  return format(day, 'yyyy-MM-dd') === format(days[days.length - 1], 'yyyy-MM-dd')
}
