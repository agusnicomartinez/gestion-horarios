import type {
  CoverageOverride,
  DayRequest,
  Employee,
  PublicHoliday,
  ScheduleEntry,
  Shift,
} from '../types/database'
import { eachDayInMonth, fromISO, isWeekend, toISO, addDays } from './dates'
import { format } from 'date-fns'

/**
 * Schedule generation algorithm — v3.
 *
 * Rules
 * ─────
 *  Stretches: 4-7 consecutive working days, ideally 5-6.
 *  Within a stretch, shifts may change M→T (the user moves "from mornings to
 *  afternoons in the same week"). T→M between consecutive working days is
 *  blocked: only 8 h between end-of-afternoon (23:00) and start-of-morning
 *  (07:00) — not enough rest. So once an employee transitions to afternoon
 *  inside a stretch they finish the stretch on afternoons.
 *  Rest: 2-4 days normally (ideal 2-3), forced back at consecutiveOff ≥ 3.
 *  After a maxed 7-day stretch: rest is exactly 3 days.
 *  Coverage: strictly 1 morning + 1 afternoon per day (default), or
 *  morningSlotsPerDay if the supervisor configured more morning slots.
 *
 * Per-day pick:
 *   1. Pick the afternoon worker (priority for afternoon-only specialists,
 *      then by tier, continuity, balance of afternoons, total shifts).
 *   2. Pick the morning worker(s) excluding the afternoon pick (priority for
 *      morning-only, then mid-stretch on morning, then balanced).
 *   3. All others are off.
 *
 * Eligibility per shift:
 *   - shift_type allows it
 *   - not approved off today
 *   - stretchDay < MAX_STRETCH (else forced rest)
 *   - sequence rule: if shift = morning and lastShift = afternoon, blocked
 *   - mid-stretch employees are always eligible (must continue)
 *   - fresh employees need consecutiveOff ≥ minRest
 *
 * Tier (for picking priority):
 *   0  must work today (mid-stretch 1-3 OR rest at preferred max)
 *   1  prefer continue (mid-stretch 4-5)
 *   2  optional fresh (rest in [minRest, maxRest-1))
 *   3  prefer end (mid-stretch 6)
 *   5  blocked (mid-stretch 7+ or rest below min)
 */

const MIN_STRETCH = 4
const MAX_STRETCH = 7
const IDEAL_MAX_STRETCH = 6
const MAX_STRETCH_AFTER_FULL = 5
const MIN_REST = 2
const PREFERRED_MAX_REST = 3
const MAX_REST = 3
const REST_AFTER_FULL = 3

export interface GenerateInput {
  monthISO: string
  employees: Employee[]
  approvedRequests: DayRequest[]
  holidays: PublicHoliday[]
  morningSlotsPerDay?: Record<string, number>
  carryOver?: Record<string, Shift[]>
  /** Total días libres regulares al año por empleado (presupuesto). */
  restDaysPerYear?: number
  /**
   * Daily coverage per shift, expressed as { min, max } where max=null
   * means no upper bound (the algorithm grows the slot to absorb tier-0
   * forced employees).
   */
  coverage?: {
    morning: { min: number; max: number | null }
    afternoon: { min: number; max: number | null }
    night: { min: number; max: number | null }
    partido: { min: number; max: number | null }
  }
  /**
   * Per-day overrides for the category coverage (occupancy peaks). Each
   * override replaces the category default for the days it covers.
   */
  coverageOverrides?: CoverageOverride[]
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
  detail: string
  employeeId?: string
}

interface Stats {
  stretchDay: number
  consecutiveOff: number
  lastStretchLength: number
  totalShifts: number
  totalMorning: number
  totalAfternoon: number
  lastShift: Shift
  weekendsOff: number
  weekendOffCurrent: boolean
}

function makeInitialStats(): Stats {
  return {
    stretchDay: 0,
    consecutiveOff: MIN_REST,
    lastStretchLength: 0,
    totalShifts: 0,
    totalMorning: 0,
    totalAfternoon: 0,
    lastShift: 'off',
    weekendsOff: 0,
    weekendOffCurrent: true,
  }
}

function shiftAllowed(emp: Employee, shift: Shift): boolean {
  if (shift === 'off') return true
  if (shift !== 'morning' && shift !== 'afternoon' && shift !== 'night' && shift !== 'partido') {
    return true
  }
  return (emp.shifts ?? ['morning', 'afternoon']).includes(shift)
}

/**
 * Default working hours per shift used to enforce the 12-hour rest rule.
 * `endsNextDay` means the shift's end time falls on the following calendar
 * day (e.g. night shift 23:00 → 7:00 next day).
 */
const SHIFT_HOURS: Record<
  'morning' | 'afternoon' | 'night' | 'partido',
  { start: number; end: number; endsNextDay: boolean }
> = {
  morning: { start: 7, end: 15, endsNextDay: false },
  afternoon: { start: 15, end: 23, endsNextDay: false },
  night: { start: 23, end: 7, endsNextDay: true },
  partido: { start: 9, end: 21, endsNextDay: false },
}

function isWorkShift(s: Shift): s is 'morning' | 'afternoon' | 'night' | 'partido' {
  return s === 'morning' || s === 'afternoon' || s === 'night' || s === 'partido'
}

/** Can an employee whose previous day's shift was `prev` start `next` today? */
function canTransition(prev: Shift, next: Shift): boolean {
  if (!isWorkShift(prev) || !isWorkShift(next)) return true
  const p = SHIFT_HOURS[prev]
  const n = SHIFT_HOURS[next]
  // Treat prev as occupying day D. If endsNextDay, prev finishes at hour
  // 24 + p.end. Otherwise just p.end. Next shift starts on day D+1 at
  // 24 + n.start. Gap must be ≥ 12 h.
  const prevEndAbs = (p.endsNextDay ? 24 : 0) + p.end
  const nextStartAbs = 24 + n.start
  return nextStartAbs - prevEndAbs >= 12
}

function isOff(empId: string, dateISO: string, requests: DayRequest[]): boolean {
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

function isWorkingShift(shift: Shift): boolean {
  return (
    shift === 'morning' ||
    shift === 'afternoon' ||
    shift === 'night' ||
    shift === 'partido'
  )
}

function canSustainStretch(
  empId: string,
  dateISO: string,
  requests: DayRequest[],
): boolean {
  const start = fromISO(dateISO)
  for (let i = 0; i < MIN_STRETCH; i++) {
    const d = toISO(addDays(start, i))
    if (isOff(empId, d, requests)) return false
  }
  return true
}

function applyCarryOver(stats: Stats, recent: Shift[]) {
  if (recent.length === 0) return
  const last = recent[recent.length - 1]
  if (last === 'off') {
    let off = 0
    for (let i = recent.length - 1; i >= 0 && recent[i] === 'off'; i--) off++
    let stretchLen = 0
    for (let i = recent.length - 1 - off; i >= 0 && recent[i] !== 'off'; i--) stretchLen++
    stats.consecutiveOff = off
    stats.lastStretchLength = stretchLen
  } else {
    let day = 0
    for (let i = recent.length - 1; i >= 0 && recent[i] !== 'off'; i--) day++
    stats.stretchDay = day
    stats.consecutiveOff = 0
  }
  stats.lastShift = last
}

function minRestFor(s: Stats): number {
  return s.lastStretchLength >= MAX_STRETCH ? REST_AFTER_FULL : MIN_REST
}

function maxRestFor(s: Stats): number {
  return s.lastStretchLength >= MAX_STRETCH ? REST_AFTER_FULL : MAX_REST
}

function tier(s: Stats): number {
  if (s.stretchDay >= MAX_STRETCH) return 5
  // After a 7-day stretch, the next stretch is capped at 5 days (ideal
  // recovery — the user wants the technician to take a lighter cycle
  // before the next full one).
  if (s.stretchDay >= MAX_STRETCH_AFTER_FULL && s.lastStretchLength >= MAX_STRETCH) {
    return 5
  }
  if (s.stretchDay >= 1) {
    if (s.stretchDay < MIN_STRETCH) return 0
    if (s.stretchDay < IDEAL_MAX_STRETCH) return 1
    return 3
  }
  const minR = minRestFor(s)
  if (s.consecutiveOff < minR) return 5
  if (s.consecutiveOff >= PREFERRED_MAX_REST) return 0
  return 2
}

interface Weekend {
  sat: string
  sun: string
}

function findWeekends(monthDays: Date[]): Weekend[] {
  const weekends: Weekend[] = []
  for (let i = 0; i < monthDays.length - 1; i++) {
    const d = monthDays[i]
    const next = monthDays[i + 1]
    if (d.getDay() === 6 && next.getDay() === 0) {
      weekends.push({ sat: toISO(d), sun: toISO(next) })
    }
  }
  return weekends
}

function hasFullWeekendOff(
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

/**
 * Distribute weekend offs so every employee gets ≥1 full weekend per month.
 * Tries to spread "both" employees across different weekends (so the
 * remaining "both"s can still cover the morning slot if Jordi-equivalents
 * are also resting that weekend).
 */
function assignWeekendOffs(
  employees: Employee[],
  weekends: Weekend[],
  approvedRequests: DayRequest[],
  monthISO: string,
): DayRequest[] {
  if (weekends.length === 0) return []
  const synthetic: DayRequest[] = []
  const need = employees.filter(
    (e) => !hasFullWeekendOff(e.id, weekends, approvedRequests),
  )
  // Sort: morning-or-afternoon-only first (they're constrained), then "both"
  // — so specialists get assigned first, "both"s spread across remaining slots.
  // Constrained employees (single allowed shift) first, then those who can
  // do multiple shifts.
  const ordered = [...need].sort((a, b) => {
    const sa = (a.shifts ?? ['morning', 'afternoon']).length > 1 ? 1 : 0
    const sb = (b.shifts ?? ['morning', 'afternoon']).length > 1 ? 1 : 0
    return sa - sb
  })
  // Track how many already assigned per weekend
  const perWeekend: number[] = weekends.map(() => 0)
  for (const e of ordered) {
    let bestIdx = 0
    for (let i = 1; i < weekends.length; i++) {
      if (perWeekend[i] < perWeekend[bestIdx]) bestIdx = i
    }
    const w = weekends[bestIdx]
    perWeekend[bestIdx]++
    synthetic.push({
      id: `weekend-off-${e.id}-${w.sat}`,
      employee_id: e.id,
      type: 'personal',
      start_date: w.sat,
      end_date: w.sun,
      status: 'approved',
      target_month: monthISO,
    })
  }
  return synthetic
}

export function generateSchedule(input: GenerateInput): GenerateOutput {
  const monthDate = fromISO(input.monthISO)
  const days = eachDayInMonth(monthDate)
  const entries: Omit<ScheduleEntry, 'id' | 'schedule_id'>[] = []
  const violations: Violation[] = []

  const stats = new Map<string, Stats>()
  for (const e of input.employees) {
    const s = makeInitialStats()
    if (input.carryOver?.[e.id]) applyCarryOver(s, input.carryOver[e.id])
    stats.set(e.id, s)
  }

  const weekendsInMonth = findWeekends(days)
  const syntheticWeekendOffs = assignWeekendOffs(
    input.employees,
    weekendsInMonth,
    input.approvedRequests,
    input.monthISO,
  )
  const allOffs: DayRequest[] = [
    ...input.approvedRequests,
    ...syntheticWeekendOffs,
  ]

  let prevWasWeekend = false

  const isShiftEligible = (
    e: Employee,
    shift: 'morning' | 'afternoon' | 'night' | 'partido',
    dailyAssignment: Map<string, Shift>,
    dISO: string,
  ): boolean => {
    if (dailyAssignment.has(e.id)) return false
    if (!shiftAllowed(e, shift)) return false
    const s = stats.get(e.id)!
    if (s.stretchDay >= MAX_STRETCH) return false
    // After a 7-day stretch, cap the next one at 5 days (lighter
    // recovery cycle).
    if (s.stretchDay >= MAX_STRETCH_AFTER_FULL && s.lastStretchLength >= MAX_STRETCH) {
      return false
    }
    // 12-hour rest rule between consecutive working days.
    if (!canTransition(s.lastShift, shift)) return false
    if (s.stretchDay >= 1) return true
    if (s.consecutiveOff < minRestFor(s)) return false
    // Forced (rest at preferred max): must work today even if upcoming
    // approved off would cut the stretch short — strict rest cap takes
    // precedence over min-stretch (short-stretch violation is suppressed
    // when the cut is caused by an approved off).
    if (s.consecutiveOff >= PREFERRED_MAX_REST) return true
    // Single-shift specialists (e.g., afternoon-only) bypass canSustain:
    // they're the natural cover for their shift, and a short stretch caused
    // by their assigned weekend off is already suppressed.
    const empShifts = e.shifts ?? ['morning', 'afternoon']
    if (empShifts.length === 1) return true
    // Optional fresh start for "both" employees: only if can sustain MIN_STRETCH.
    return canSustainStretch(e.id, dISO, allOffs)
  }

  const score = (
    e: Employee,
    shift: 'morning' | 'afternoon' | 'night' | 'partido',
  ): number[] => {
    const s = stats.get(e.id)!
    const t = tier(s)
    const empShifts = e.shifts ?? ['morning', 'afternoon']
    const isSpecialist = empShifts.length === 1 && empShifts[0] === shift ? 0 : 1
    const continuity = s.lastShift === shift ? 0 : 1
    const transitionPick = continuity === 1 ? -s.stretchDay : 0
    const myShiftCount =
      shift === 'morning'
        ? s.totalMorning
        : shift === 'afternoon'
          ? s.totalAfternoon
          : 0
    return [isSpecialist, continuity, transitionPick, t, myShiftCount, s.totalShifts]
  }

  const pickShiftWorker = (
    shift: 'morning' | 'afternoon' | 'night' | 'partido',
    dailyAssignment: Map<string, Shift>,
    dISO: string,
  ): string | null => {
    const candidates = input.employees.filter((e) =>
      isShiftEligible(e, shift, dailyAssignment, dISO),
    )
    if (candidates.length === 0) return null
    candidates.sort((a, b) => {
      const sA = score(a, shift)
      const sB = score(b, shift)
      for (let i = 0; i < sA.length; i++) {
        if (sA[i] !== sB[i]) return sA[i] - sB[i]
      }
      return 0
    })
    return candidates[0].id
  }

  for (const day of days) {
    const dISO = toISO(day)
    const weekend = isWeekend(day)
    const dailyAssignment = new Map<string, Shift>()

    if (weekend && !prevWasWeekend) {
      for (const e of input.employees) stats.get(e.id)!.weekendOffCurrent = true
    }

    const dailyAssignmentSource = new Map<string, 'auto' | 'request'>()
    for (const e of input.employees) {
      const req = approvedOffFor(e.id, dISO, allOffs)
      if (req) {
        if (req.id.startsWith('weekend-off-')) {
          // Synthetic weekend assignment — algorithmic 'libre', not a request.
          dailyAssignment.set(e.id, 'off')
          dailyAssignmentSource.set(e.id, 'auto')
        } else {
          // Real approved request — preserve the request type so the cell
          // shows V / F / P, not just L.
          dailyAssignment.set(e.id, req.type as Shift)
          dailyAssignmentSource.set(e.id, 'request')
        }
      }
    }

    const cov = input.coverage ?? DEFAULT_COVERAGE
    const effective = (shift: 'morning' | 'afternoon' | 'night' | 'partido'): {
      min: number
      max: number | null
    } => {
      const o = (input.coverageOverrides ?? []).find(
        (x) => x.shift === shift && dISO >= x.start_date && dISO <= x.end_date,
      )
      const base = cov[shift]
      const min = o && o.min !== null && o.min !== undefined ? o.min : base.min
      const max =
        o && o.max !== undefined ? o.max : base.max
      return { min, max }
    }

    // Pick afternoon / night / partido first — these are typically more
    // constrained (only specific employees can do them). Each shift's
    // bounds (min, max) come from the category's coverage, possibly
    // overridden by a Pico de Demanda for this date.
    //
    // Placement rule: place at least `min` workers; keep adding if any
    // tier-0/1/3 employee is still pending and we haven't hit `max`. A
    // null max means no upper bound (used for morning by default).
    const placeFor = (shift: 'morning' | 'afternoon' | 'night' | 'partido') => {
      const eff = effective(shift)
      if (eff.min <= 0 && eff.max === 0) return
      let placed = 0
      const cap = eff.max
      while (true) {
        if (cap !== null && placed >= cap) break
        const pending = input.employees.some((e) => {
          if (dailyAssignment.has(e.id)) return false
          const s = stats.get(e.id)!
          const t = tier(s)
          if (t >= 5) return false
          if (t === 2) return false
          return isShiftEligible(e, shift, dailyAssignment, dISO)
        })
        if (placed >= eff.min && !pending) break
        const id = pickShiftWorker(shift, dailyAssignment, dISO)
        if (!id) break
        dailyAssignment.set(id, shift)
        placed++
      }
      if (placed < eff.min) {
        const labelMap = {
          morning: 'mañana',
          afternoon: 'tarde',
          night: 'noche',
          partido: 'partido',
        } as const
        violations.push({
          date: dISO,
          kind: shift === 'morning' ? 'no-morning-coverage' : 'no-afternoon-coverage',
          detail: `Cobertura insuficiente de ${labelMap[shift]} el ${dISO} (${placed}/${eff.min})`,
        })
      }
    }
    placeFor('afternoon')
    placeFor('night')
    placeFor('partido')

    // Morning: at least 1, plus any employee who *should* work today but
    // hasn't been placed yet. With 4 employees and a single afternoon
    // specialist, the math forces some excess; growing morning is the
    // intended escape valve (per spec: "el supervisor puede agregar más
    // de 1 persona al turno mañana según demanda"). Includes:
    //   - tier 0 forced fresh (rest at preferred max)
    //   - tier 1 mid-stretch (would otherwise be dropped from slot and
    //     end up resting more than the cap before being eligible again)
    placeFor('morning')

    for (const e of input.employees) {
      const final: Shift = dailyAssignment.get(e.id) ?? 'off'
      const sourceFor = dailyAssignmentSource.get(e.id) ?? 'auto'
      entries.push({
        employee_id: e.id,
        date: dISO,
        shift: final,
        source: sourceFor,
      })
      const s = stats.get(e.id)!
      const wasApprovedOff = isOff(e.id, dISO, allOffs)

      if (isWorkingShift(final)) {
        s.stretchDay = s.stretchDay >= 1 ? s.stretchDay + 1 : 1
        s.totalShifts += 1
        if (final === 'morning') s.totalMorning += 1
        else if (final === 'afternoon') s.totalAfternoon += 1
        s.consecutiveOff = 0
        s.lastShift = final
        if (weekend) s.weekendOffCurrent = false
      } else {
        if (s.stretchDay > 0) {
          s.lastStretchLength = s.stretchDay
          if (s.stretchDay < MIN_STRETCH && !wasApprovedOff) {
            violations.push({
              date: dISO,
              kind: 'short-stretch',
              employeeId: e.id,
              detail: `${e.full_name} terminó un ciclo de solo ${s.stretchDay} día(s) — mínimo ${MIN_STRETCH}`,
            })
          }
          s.stretchDay = 0
        }
        s.consecutiveOff += 1
        s.lastShift = 'off'
        const myMax = maxRestFor(s)
        if (!wasApprovedOff && s.consecutiveOff === myMax + 1) {
          violations.push({
            date: dISO,
            kind: 'over-max-rest',
            employeeId: e.id,
            detail: `${e.full_name} supera los ${myMax} días de descanso a partir del ${dISO}`,
          })
        }
      }
    }

    if (weekend && (day.getDay() === 0 || isLastDay(day, days))) {
      for (const e of input.employees) {
        const s = stats.get(e.id)!
        if (s.weekendOffCurrent) s.weekendsOff += 1
      }
    }
    prevWasWeekend = weekend
  }

  for (const e of input.employees) {
    const s = stats.get(e.id)!
    if (s.weekendsOff === 0) {
      violations.push({
        date: input.monthISO,
        kind: 'no-weekend-rest',
        employeeId: e.id,
        detail: `${e.full_name} no tiene ningún fin de semana completo de descanso este mes`,
      })
    }
  }

  // Annual rest budget check: warn if monthly off days deviate too much
  // from the target (rest_days_per_year / 12). Tolerance ±3 days.
  if (input.restDaysPerYear && input.restDaysPerYear > 0) {
    const monthlyTarget = input.restDaysPerYear / 12
    for (const e of input.employees) {
      const myEntries = entries.filter((x) => x.employee_id === e.id)
      const offCount = myEntries.filter((x) => x.shift === 'off').length
      const deviation = offCount - monthlyTarget
      if (Math.abs(deviation) > 3) {
        violations.push({
          date: input.monthISO,
          kind: 'budget-deviation',
          employeeId: e.id,
          detail: `${e.full_name}: ${offCount} días libres este mes (objetivo ${monthlyTarget.toFixed(1)} ± 3, desviación ${deviation > 0 ? '+' : ''}${deviation.toFixed(0)})`,
        })
      }
    }
  }

  return { entries, violations }
}

function isLastDay(day: Date, days: Date[]): boolean {
  return format(day, 'yyyy-MM-dd') === format(days[days.length - 1], 'yyyy-MM-dd')
}

export function carryOverFromEntries(
  prevMonthEntries: Pick<ScheduleEntry, 'employee_id' | 'date' | 'shift'>[],
  monthISO: string,
): Record<string, Shift[]> {
  const start = addDays(fromISO(monthISO), -10)
  const startISO = toISO(start)
  const filtered = prevMonthEntries
    .filter((e) => e.date >= startISO && e.date < monthISO)
    .sort((a, b) => a.date.localeCompare(b.date))
  const grouped: Record<string, Shift[]> = {}
  for (const e of filtered) {
    if (!grouped[e.employee_id]) grouped[e.employee_id] = []
    // Vacation/holiday/personal cells count as 'off' for stretch / rest
    // counting purposes so they break stretches correctly.
    const normalised: Shift =
      e.shift === 'morning' || e.shift === 'afternoon' ? e.shift : 'off'
    grouped[e.employee_id].push(normalised)
  }
  return grouped
}
