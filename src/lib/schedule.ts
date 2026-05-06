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
 * Schedule generation algorithm — v2.
 *
 * Rules
 * ─────
 *  Stretches (ciclos de trabajo): 4-7 consecutive days, ideally 5-6.
 *    Same shift (morning OR afternoon) for the whole stretch — no flips inside.
 *  Rest: 2-4 days normally (ideally 2-3), forced back to work after 4.
 *    After a maxed 7-day stretch: rest is exactly 3 days.
 *  Coverage: ≥1 employee on morning, ≥1 on afternoon every day.
 *  Sequence: no afternoon → morning when starting a new stretch.
 *
 * The algorithm walks day-by-day and groups eligible employees into tiers:
 *
 *   tier 0  must work today
 *           - mid-stretch days 1-3  (else min-4 violation)
 *           - rest maxed (consecutiveOff ≥ maxRest)
 *   tier 1  prefer to work today
 *           - mid-stretch day 4     (toward ideal 5-6)
 *           - rest at maxRest-1     (last preferred day before forced)
 *   tier 2  fresh, optional
 *           - rest in [minRest, maxRest-1)
 *   tier 3  mid-stretch day 5       (could continue toward 6)
 *   tier 4  mid-stretch day 6       (prefer end at ideal max)
 *   tier 5  blocked
 *           - mid-stretch day 7     (must rest tomorrow)
 *           - rest below minRest    (still resting)
 *
 * Slot allocation per day:
 *   Pass 1 — assign all tier 0 (must work). Their shift slots grow naturally
 *            so multiple morning or afternoon workers share a day.
 *   Pass 2 — fill until coverage minimums (1 morning + 1 afternoon, or
 *            morningSlotsPerDay if supervisor-configured) using tier 1, 2, 3, 4.
 *
 * With 6 employees and the 5:2 ratio, this produces ~4 working/day naturally,
 * spread between the two shifts.
 */

const MIN_STRETCH = 4
const MAX_STRETCH = 7
const IDEAL_MAX_STRETCH = 6
const MIN_REST = 2
const PREFERRED_MAX_REST = 3
const MAX_REST = 4
const REST_AFTER_FULL = 3

export interface GenerateInput {
  monthISO: string
  employees: Employee[]
  approvedRequests: DayRequest[]
  holidays: PublicHoliday[]
  morningSlotsPerDay?: Record<string, number>
  carryOver?: Record<string, Shift[]>
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
    | 'forced-coverage'
  detail: string
  employeeId?: string
}

interface Stats {
  stretchDay: number
  stretchShift: Shift
  consecutiveOff: number
  lastStretchLength: number
  totalShifts: number
  lastShift: Shift
  weekendsOff: number
  weekendOffCurrent: boolean
}

function makeInitialStats(): Stats {
  return {
    stretchDay: 0,
    stretchShift: 'off',
    consecutiveOff: MIN_REST,
    lastStretchLength: 0,
    totalShifts: 0,
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

function assignWeekendOffs(
  employees: Employee[],
  weekends: Weekend[],
  approvedRequests: DayRequest[],
  monthISO: string,
): DayRequest[] {
  if (weekends.length === 0) return []
  const synthetic: DayRequest[] = []
  let cursor = 0
  for (const e of employees) {
    if (hasFullWeekendOff(e.id, weekends, approvedRequests)) continue
    const w = weekends[cursor % weekends.length]
    synthetic.push({
      id: `weekend-off-${e.id}-${w.sat}`,
      employee_id: e.id,
      type: 'personal',
      start_date: w.sat,
      end_date: w.sun,
      status: 'approved',
      target_month: monthISO,
    })
    cursor++
  }
  return synthetic
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
    stats.stretchShift = last
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
    if (s.stretchDay < IDEAL_MAX_STRETCH) return 0
    return 1
  }
  const minR = minRestFor(s)
  if (s.consecutiveOff < minR) return 5
  if (s.consecutiveOff >= PREFERRED_MAX_REST) return 0
  return 2
}

interface Candidate {
  emp: Employee
  shift: 'morning' | 'afternoon'
  tierVal: number
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
  const allOffs: DayRequest[] = [...input.approvedRequests, ...syntheticWeekendOffs]

  let prevWasWeekend = false

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

    const cands: Candidate[] = []
    for (const e of input.employees) {
      if (dailyAssignment.has(e.id)) continue
      const s = stats.get(e.id)!
      const t = tier(s)
      if (t >= 5) continue
      if (s.stretchDay >= 1) {
        if (s.stretchShift === 'morning' || s.stretchShift === 'afternoon') {
          if (shiftAllowed(e, s.stretchShift)) {
            cands.push({ emp: e, shift: s.stretchShift, tierVal: t })
          }
        }
      } else {
        if (t > 0 && !canSustainStretch(e.id, dISO, allOffs)) continue
        if (shiftAllowed(e, 'morning') && s.lastShift !== 'afternoon') {
          cands.push({ emp: e, shift: 'morning', tierVal: t })
        }
        if (shiftAllowed(e, 'afternoon')) {
          cands.push({ emp: e, shift: 'afternoon', tierVal: t })
        }
      }
    }

    cands.sort((a, b) => {
      if (a.tierVal !== b.tierVal) return a.tierVal - b.tierVal
      const sA = stats.get(a.emp.id)!
      const sB = stats.get(b.emp.id)!
      const midA = sA.stretchDay >= 1 ? 0 : 1
      const midB = sB.stretchDay >= 1 ? 0 : 1
      if (midA !== midB) return midA - midB
      return sA.totalShifts - sB.totalShifts
    })

    const assigned = new Set<string>()
    let morningCount = 0
    let afternoonCount = 0

    const place = (empId: string, shift: 'morning' | 'afternoon') => {
      dailyAssignment.set(empId, shift)
      assigned.add(empId)
      if (shift === 'morning') morningCount++
      else afternoonCount++
    }

    for (const c of cands) {
      if (c.tierVal !== 0) continue
      if (assigned.has(c.emp.id)) continue
      const s = stats.get(c.emp.id)!
      if (s.stretchDay >= 1) {
        place(c.emp.id, c.shift)
      } else {
        const canM = shiftAllowed(c.emp, 'morning') && s.lastShift !== 'afternoon'
        const canA = shiftAllowed(c.emp, 'afternoon')
        let pick: 'morning' | 'afternoon' | null = null
        if (canM && canA) pick = morningCount <= afternoonCount ? 'morning' : 'afternoon'
        else if (canM) pick = 'morning'
        else if (canA) pick = 'afternoon'
        if (pick) place(c.emp.id, pick)
      }
    }

    const targetMorning = input.morningSlotsPerDay?.[dISO] ?? 1
    const targetAfternoon = 1

    for (const c of cands) {
      if (c.tierVal === 0) continue
      if (assigned.has(c.emp.id)) continue
      if (morningCount >= targetMorning && afternoonCount >= targetAfternoon) break
      const s = stats.get(c.emp.id)!
      if (s.stretchDay >= 1) {
        if (c.shift === 'morning' && morningCount < targetMorning) place(c.emp.id, 'morning')
        else if (c.shift === 'afternoon' && afternoonCount < targetAfternoon) place(c.emp.id, 'afternoon')
      } else {
        if (morningCount < targetMorning && shiftAllowed(c.emp, 'morning') && s.lastShift !== 'afternoon') {
          place(c.emp.id, 'morning')
        } else if (afternoonCount < targetAfternoon && shiftAllowed(c.emp, 'afternoon')) {
          place(c.emp.id, 'afternoon')
        }
      }
    }

    const fallbackPick = (needShift: 'morning' | 'afternoon'): string | null => {
      const eligible = input.employees.filter((e) => {
        if (dailyAssignment.has(e.id)) return false
        if (!shiftAllowed(e, needShift)) return false
        const s = stats.get(e.id)!
        if (s.stretchDay >= MAX_STRETCH) return false
        if (s.stretchDay >= 1 && s.stretchShift !== needShift) return false
        if (s.stretchDay === 0 && needShift === 'morning' && s.lastShift === 'afternoon') return false
        return true
      })
      if (eligible.length === 0) return null
      eligible.sort((a, b) => stats.get(b.id)!.consecutiveOff - stats.get(a.id)!.consecutiveOff)
      return eligible[0].id
    }

    if (morningCount < targetMorning) {
      const id = fallbackPick('morning')
      if (id) {
        place(id, 'morning')
        violations.push({
          date: dISO,
          kind: 'forced-coverage',
          employeeId: id,
          detail: `Cobertura de mañana cubierta forzando a un empleado fuera de su descanso ideal el ${dISO}`,
        })
      } else {
        violations.push({
          date: dISO,
          kind: 'no-morning-coverage',
          detail: `Sin cobertura de mañana el ${dISO} (ningún empleado disponible)`,
        })
      }
    }
    if (afternoonCount < targetAfternoon) {
      const id = fallbackPick('afternoon')
      if (id) {
        place(id, 'afternoon')
        violations.push({
          date: dISO,
          kind: 'forced-coverage',
          employeeId: id,
          detail: `Cobertura de tarde cubierta forzando a un empleado fuera de su descanso ideal el ${dISO}`,
        })
      } else {
        violations.push({
          date: dISO,
          kind: 'no-afternoon-coverage',
          detail: `Sin cobertura de tarde el ${dISO} (ningún empleado disponible)`,
        })
      }
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
        if (s.stretchDay === 0) {
          s.stretchDay = 1
          s.stretchShift = final
        } else {
          s.stretchDay += 1
        }
        s.totalShifts += 1
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
          s.stretchShift = 'off'
        }
        s.consecutiveOff += 1
        s.lastShift = 'off'
        if (!wasApprovedOff && canSustainStretch(e.id, dISO, allOffs)) {
          const myMax = maxRestFor(s)
          if (s.consecutiveOff > myMax) {
            violations.push({
              date: dISO,
              kind: 'over-max-rest',
              employeeId: e.id,
              detail: `${e.full_name} acumula ${s.consecutiveOff} días de descanso (máximo ${myMax})`,
            })
          }
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
