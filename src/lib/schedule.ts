import type {
  Employee,
  PublicHoliday,
  DayRequest,
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
  if (emp.shift_type === 'both') return true
  if (emp.shift_type === 'morning') return shift === 'morning'
  if (emp.shift_type === 'afternoon') return shift === 'afternoon'
  return false
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
  const ordered = [...need].sort((a, b) => {
    const sa = a.shift_type === 'both' ? 1 : 0
    const sb = b.shift_type === 'both' ? 1 : 0
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
    shift: 'morning' | 'afternoon',
    dailyAssignment: Map<string, Shift>,
    dISO: string,
  ): boolean => {
    if (dailyAssignment.has(e.id)) return false
    if (!shiftAllowed(e, shift)) return false
    const s = stats.get(e.id)!
    if (s.stretchDay >= MAX_STRETCH) return false
    if (shift === 'morning' && s.lastShift === 'afternoon') return false
    if (s.stretchDay >= 1) return true
    if (s.consecutiveOff < minRestFor(s)) return false
    // Forced (rest at preferred max): must work today even if upcoming
    // approved off would cut the stretch short — strict rest cap takes
    // precedence over min-stretch (short-stretch violation is suppressed
    // when the cut is caused by an approved off).
    if (s.consecutiveOff >= PREFERRED_MAX_REST) return true
    // Single-shift specialists (e.g., afternoon-only) bypass canSustain too:
    // they're the natural cover for their shift, and a short stretch caused
    // by their assigned weekend off is already suppressed. Without this they
    // get blocked, the "both" employees fill in and get displaced when the
    // specialist returns — that creates the actual short stretches.
    if (e.shift_type !== 'both') return true
    // Optional fresh start for "both" employees: only if can sustain MIN_STRETCH.
    return canSustainStretch(e.id, dISO, allOffs)
  }

  const score = (e: Employee, shift: 'morning' | 'afternoon'): number[] => {
    const s = stats.get(e.id)!
    const t = tier(s)
    const isSpecialist = e.shift_type === shift ? 0 : 1
    const continuity = s.lastShift === shift ? 0 : 1
    // When forced to transition (continuity=1, e.g., a "both" employee covers
    // afternoon while Jordi rests), prefer the candidate whose existing stretch
    // is longest. That employee's stretch already has decent length, so the
    // transition won't truncate it below MIN_STRETCH.
    const transitionPick = continuity === 1 ? -s.stretchDay : 0
    const myShiftCount = shift === 'morning' ? s.totalMorning : s.totalAfternoon
    // Specialist beats everything (Jordi covers afternoon when eligible).
    // Continuity next (no shift change preferred). Then transitionPick: if
    // a transition is unavoidable, prefer the candidate whose existing
    // stretch is longest — their combined stretch will still meet MIN_STRETCH,
    // whereas a fresh employee transitioning would start a stretch that
    // gets cut short the moment the specialist returns. Tier comes after.
    return [isSpecialist, continuity, transitionPick, t, myShiftCount, s.totalShifts]
  }

  const pickShiftWorker = (
    shift: 'morning' | 'afternoon',
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

    for (const e of input.employees) {
      if (isOff(e.id, dISO, allOffs)) {
        dailyAssignment.set(e.id, 'off')
      }
    }

    // Afternoon: strict 1 worker (per user spec).
    const afternoonId = pickShiftWorker('afternoon', dailyAssignment, dISO)
    if (afternoonId) {
      dailyAssignment.set(afternoonId, 'afternoon')
    } else {
      violations.push({
        date: dISO,
        kind: 'no-afternoon-coverage',
        detail: `Sin cobertura de tarde el ${dISO}`,
      })
    }

    // Morning: at least 1, plus any employee who *should* work today but
    // hasn't been placed yet. With 4 employees and a single afternoon
    // specialist, the math forces some excess; growing morning is the
    // intended escape valve (per spec: "el supervisor puede agregar más
    // de 1 persona al turno mañana según demanda"). Includes:
    //   - tier 0 forced fresh (rest at preferred max)
    //   - tier 1 mid-stretch (would otherwise be dropped from slot and
    //     end up resting more than the cap before being eligible again)
    const baseMorning = input.morningSlotsPerDay?.[dISO] ?? 1
    let placedMorning = 0
    while (true) {
      const pending = input.employees.some((e) => {
        if (dailyAssignment.has(e.id)) return false
        const s = stats.get(e.id)!
        const t = tier(s)
        if (t >= 5) return false
        // Include tier 0 (forced), tier 1 (mid 4-5), tier 3 (mid 6 — extending
        // to 7 max and triggering the mandatory 3-day rest is preferable to
        // ending at 6 and risking a longer-than-3 rest gap before the next
        // approved off allows a restart). Excludes tier 2 (fresh optional).
        if (t === 2) return false
        return isShiftEligible(e, 'morning', dailyAssignment, dISO)
      })
      if (placedMorning >= baseMorning && !pending) break
      const morningId = pickShiftWorker('morning', dailyAssignment, dISO)
      if (!morningId) break
      dailyAssignment.set(morningId, 'morning')
      placedMorning++
    }
    if (placedMorning === 0) {
      violations.push({
        date: dISO,
        kind: 'no-morning-coverage',
        detail: `Sin cobertura de mañana el ${dISO}`,
      })
    }

    for (const e of input.employees) {
      const final: Shift = dailyAssignment.get(e.id) ?? 'off'
      entries.push({
        employee_id: e.id,
        date: dISO,
        shift: final,
        source: 'auto',
      })
      const s = stats.get(e.id)!
      const wasApprovedOff = isOff(e.id, dISO, allOffs)

      if (final !== 'off') {
        s.stretchDay = s.stretchDay >= 1 ? s.stretchDay + 1 : 1
        s.totalShifts += 1
        if (final === 'morning') s.totalMorning += 1
        else s.totalAfternoon += 1
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
    grouped[e.employee_id].push(e.shift)
  }
  return grouped
}
