import type {
  Employee,
  PublicHoliday,
  DayRequest,
  ScheduleEntry,
  Shift,
} from '../types/database'
import { eachDayInMonth, fromISO, isWeekend, toISO, addDays } from './dates'
import { format } from 'date-fns'

export interface GenerateInput {
  monthISO: string
  employees: Employee[]
  approvedRequests: DayRequest[]
  holidays: PublicHoliday[]
  morningSlotsPerDay?: Record<string, number>
  carryOver?: Record<string, Shift[]>
}

export type DayShifts = Record<string, Shift>

export interface GenerateOutput {
  entries: Omit<ScheduleEntry, 'id' | 'schedule_id'>[]
  violations: Violation[]
}

export interface Violation {
  date: string
  kind:
    | 'no-morning-coverage'
    | 'no-afternoon-coverage'
    | 'sequence-violation'
    | 'over-7-days'
    | 'no-weekend-rest'
  detail: string
  employeeId?: string
}

interface State {
  consecutiveWork: Map<string, number>
  consecutiveOff: Map<string, number>
  lastShift: Map<string, Shift>
  totalShifts: Map<string, number>
  weekendsOff: Map<string, number>
  weekendOffCurrent: Map<string, boolean>
}

function fairnessScore(
  empId: string,
  state: State,
  shift: Shift,
): number {
  const total = state.totalShifts.get(empId) ?? 0
  const consecutive = state.consecutiveWork.get(empId) ?? 0
  const last = state.lastShift.get(empId)
  let score = total * 10 + consecutive * 3
  if (shift === 'morning' && last === 'morning') score += 1
  if (shift === 'afternoon' && last === 'afternoon') score += 1
  return score
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

export function generateSchedule(input: GenerateInput): GenerateOutput {
  const monthDate = fromISO(input.monthISO)
  const days = eachDayInMonth(monthDate)
  const entries: Omit<ScheduleEntry, 'id' | 'schedule_id'>[] = []
  const violations: Violation[] = []

  const state: State = {
    consecutiveWork: new Map(),
    consecutiveOff: new Map(),
    lastShift: new Map(),
    totalShifts: new Map(),
    weekendsOff: new Map(),
    weekendOffCurrent: new Map(),
  }
  for (const e of input.employees) {
    state.consecutiveWork.set(e.id, 0)
    state.consecutiveOff.set(e.id, 0)
    state.totalShifts.set(e.id, 0)
    state.weekendsOff.set(e.id, 0)
    state.weekendOffCurrent.set(e.id, true)
  }

  // Apply carry-over from previous month so sequence rules are correct on day 1
  if (input.carryOver) {
    for (const [empId, recent] of Object.entries(input.carryOver)) {
      const last = recent[recent.length - 1]
      if (last) state.lastShift.set(empId, last)
      let cw = 0
      for (let i = recent.length - 1; i >= 0; i--) {
        if (recent[i] !== 'off') cw++
        else break
      }
      state.consecutiveWork.set(empId, cw)
    }
  }

  let prevWasWeekend = false

  for (const day of days) {
    const dISO = toISO(day)
    const weekend = isWeekend(day)
    const dailyAssignment: DayShifts = {}

    if (weekend && !prevWasWeekend) {
      for (const e of input.employees) state.weekendOffCurrent.set(e.id, true)
    }

    // Helper: pick best candidate for a shift. Returns id or null.
    const pickFor = (
      shift: 'morning' | 'afternoon',
      excluded: Set<string>,
    ): string | null => {
      const candidates = input.employees.filter((e) => {
        if (excluded.has(e.id)) return false
        if (dailyAssignment[e.id]) return false
        if (!shiftAllowed(e, shift)) return false
        if (isOff(e.id, dISO, input.approvedRequests)) return false
        const cw = state.consecutiveWork.get(e.id) ?? 0
        if (cw >= 7) return false
        if (shift === 'morning' && state.lastShift.get(e.id) === 'afternoon') return false
        return true
      })
      if (candidates.length === 0) return null
      candidates.sort(
        (a, b) => fairnessScore(a.id, state, shift) - fairnessScore(b.id, state, shift),
      )
      return candidates[0].id
    }

    const morningSlots = input.morningSlotsPerDay?.[dISO] ?? 1
    const used = new Set<string>()
    for (let s = 0; s < morningSlots; s++) {
      const id = pickFor('morning', used)
      if (!id) {
        if (s === 0) {
          violations.push({
            date: dISO,
            kind: 'no-morning-coverage',
            detail: `No hay empleado disponible para el turno de mañana del ${dISO}`,
          })
        }
        break
      }
      dailyAssignment[id] = 'morning'
      used.add(id)
    }

    const afternoonId = pickFor('afternoon', used)
    if (afternoonId) {
      dailyAssignment[afternoonId] = 'afternoon'
    } else {
      violations.push({
        date: dISO,
        kind: 'no-afternoon-coverage',
        detail: `No hay empleado disponible para el turno de tarde del ${dISO}`,
      })
    }

    for (const e of input.employees) {
      const shift: Shift = dailyAssignment[e.id] ?? 'off'
      entries.push({
        employee_id: e.id,
        date: dISO,
        shift,
        source: 'auto',
      })

      if (shift === 'off') {
        state.consecutiveOff.set(e.id, (state.consecutiveOff.get(e.id) ?? 0) + 1)
        state.consecutiveWork.set(e.id, 0)
      } else {
        const last = state.lastShift.get(e.id)
        if (last === 'afternoon' && shift === 'morning') {
          violations.push({
            date: dISO,
            kind: 'sequence-violation',
            employeeId: e.id,
            detail: `Empleado tiene turno mañana después de tarde el ${dISO}`,
          })
        }
        state.consecutiveWork.set(e.id, (state.consecutiveWork.get(e.id) ?? 0) + 1)
        state.consecutiveOff.set(e.id, 0)
        state.totalShifts.set(e.id, (state.totalShifts.get(e.id) ?? 0) + 1)
        if (weekend) state.weekendOffCurrent.set(e.id, false)
      }

      const cw = state.consecutiveWork.get(e.id) ?? 0
      if (cw > 7) {
        violations.push({
          date: dISO,
          kind: 'over-7-days',
          employeeId: e.id,
          detail: `Empleado lleva más de 7 días seguidos al ${dISO}`,
        })
      }
      state.lastShift.set(e.id, shift)
    }

    if (weekend && (day.getDay() === 0 || isLastDay(day, days))) {
      for (const e of input.employees) {
        if (state.weekendOffCurrent.get(e.id)) {
          state.weekendsOff.set(e.id, (state.weekendsOff.get(e.id) ?? 0) + 1)
        }
      }
    }
    prevWasWeekend = weekend
  }

  for (const e of input.employees) {
    if ((state.weekendsOff.get(e.id) ?? 0) === 0) {
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

/**
 * Get carry-over for the LAST 7 days of the previous month, used to seed
 * sequence rules in generateSchedule.
 */
export function carryOverFromEntries(
  prevMonthEntries: Pick<ScheduleEntry, 'employee_id' | 'date' | 'shift'>[],
  monthISO: string,
): Record<string, Shift[]> {
  const start = addDays(fromISO(monthISO), -7)
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
