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
 * Schedule generation algorithm.
 *
 * Core idea: each employee works in stretches (ciclos) of 4-7 consecutive days
 * (ideally 5-6), staying on the same shift (morning or afternoon) for the whole
 * stretch. Between stretches they rest 2 days (3 days if the previous stretch
 * was the maximum 7 days).
 *
 * The algorithm walks day-by-day and, for each shift slot, prefers candidates
 * by tier:
 *   tier 0  mid-stretch days 1-3  (must continue: would otherwise break min-4)
 *   tier 1  mid-stretch day 4     (strong continue, target ideal 5-6)
 *   tier 2  fresh, fully rested   (start a new stretch)
 *   tier 3  mid-stretch days 5-6  (weak continue, prefer ending here)
 *   blocked mid-stretch day 7     (forced end after this day)
 *
 * Ties within a tier are broken by total shifts in the month (fairness).
 * Violations (no-coverage, forced-start, short-stretch, no-weekend-rest) are
 * reported, never silently swallowed; the supervisor adjusts manually.
 */

const MIN_STRETCH = 4
const MAX_STRETCH = 7
const REST_AFTER_FULL = 3
const REST_AFTER_NORMAL = 2

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
    | 'forced-start'
    | 'no-weekend-rest'
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
    consecutiveOff: 99,
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

function tier(s: Stats): number {
  if (s.stretchDay >= 1 && s.stretchDay <= 3) return 0
  if (s.stretchDay === 4) return 1
  if (s.stretchDay === 0) return 2
  return 3
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

  let prevWasWeekend = false

  for (const day of days) {
    const dISO = toISO(day)
    const weekend = isWeekend(day)
    const dailyAssignment = new Map<string, Shift>()

    if (weekend && !prevWasWeekend) {
      for (const e of input.employees) stats.get(e.id)!.weekendOffCurrent = true
    }

    for (const e of input.employees) {
      if (isOff(e.id, dISO, input.approvedRequests)) {
        dailyAssignment.set(e.id, 'off')
      }
    }

    const candidatesFor = (
      shift: 'morning' | 'afternoon',
      excluded: Set<string>,
    ): Employee[] => {
      return input.employees.filter((e) => {
        if (excluded.has(e.id)) return false
        if (dailyAssignment.has(e.id)) return false
        if (!shiftAllowed(e, shift)) return false
        const s = stats.get(e.id)!
        if (s.stretchDay >= MAX_STRETCH) return false
        if (s.stretchDay >= 1) {
          return s.stretchShift === shift
        }
        const required =
          s.lastStretchLength >= MAX_STRETCH ? REST_AFTER_FULL : REST_AFTER_NORMAL
        if (s.consecutiveOff < required) return false
        if (shift === 'morning' && s.lastShift === 'afternoon') return false
        return true
      })
    }

    const sortByPriority = (a: Employee, b: Employee) => {
      const sA = stats.get(a.id)!
      const sB = stats.get(b.id)!
      const tA = tier(sA)
      const tB = tier(sB)
      if (tA !== tB) return tA - tB
      return sA.totalShifts - sB.totalShifts
    }

    const tryEmergency = (
      shift: 'morning' | 'afternoon',
      used: Set<string>,
    ): Employee | null => {
      const cands = input.employees.filter((e) => {
        if (used.has(e.id)) return false
        if (dailyAssignment.has(e.id)) return false
        if (!shiftAllowed(e, shift)) return false
        const s = stats.get(e.id)!
        if (s.stretchDay >= MAX_STRETCH) return false
        if (s.stretchDay >= 1 && s.stretchShift !== shift) return false
        return true
      })
      if (cands.length === 0) return null
      cands.sort(
        (a, b) => stats.get(a.id)!.totalShifts - stats.get(b.id)!.totalShifts,
      )
      return cands[0]
    }

    const morningSlots = input.morningSlotsPerDay?.[dISO] ?? 1
    const used = new Set<string>()
    for (let i = 0; i < morningSlots; i++) {
      const cands = candidatesFor('morning', used)
      if (cands.length > 0) {
        cands.sort(sortByPriority)
        const chosen = cands[0]
        dailyAssignment.set(chosen.id, 'morning')
        used.add(chosen.id)
      } else if (i === 0) {
        const fallback = tryEmergency('morning', used)
        if (fallback) {
          dailyAssignment.set(fallback.id, 'morning')
          used.add(fallback.id)
          violations.push({
            date: dISO,
            kind: 'forced-start',
            employeeId: fallback.id,
            detail: `Forzado a trabajar sin descanso suficiente el ${dISO} (mañana)`,
          })
        } else {
          violations.push({
            date: dISO,
            kind: 'no-morning-coverage',
            detail: `Sin cobertura de mañana el ${dISO}`,
          })
        }
        break
      } else {
        break
      }
    }

    const aftCands = candidatesFor('afternoon', used)
    if (aftCands.length > 0) {
      aftCands.sort(sortByPriority)
      dailyAssignment.set(aftCands[0].id, 'afternoon')
    } else {
      const fallback = tryEmergency('afternoon', used)
      if (fallback) {
        dailyAssignment.set(fallback.id, 'afternoon')
        violations.push({
          date: dISO,
          kind: 'forced-start',
          employeeId: fallback.id,
          detail: `Forzado a trabajar sin descanso suficiente el ${dISO} (tarde)`,
        })
      } else {
        violations.push({
          date: dISO,
          kind: 'no-afternoon-coverage',
          detail: `Sin cobertura de tarde el ${dISO}`,
        })
      }
    }

    for (const e of input.employees) {
      const assigned: Shift = dailyAssignment.get(e.id) ?? 'off'
      entries.push({
        employee_id: e.id,
        date: dISO,
        shift: assigned,
        source: 'auto',
      })
      const s = stats.get(e.id)!
      if (assigned !== 'off') {
        if (s.stretchDay === 0) {
          s.stretchDay = 1
          s.stretchShift = assigned
        } else {
          s.stretchDay += 1
        }
        s.totalShifts += 1
        s.consecutiveOff = 0
        s.lastShift = assigned
        if (weekend) s.weekendOffCurrent = false
      } else {
        if (s.stretchDay > 0) {
          s.lastStretchLength = s.stretchDay
          if (s.stretchDay < MIN_STRETCH) {
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
