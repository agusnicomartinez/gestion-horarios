import type { DayRequest, GlobalSettings, ScheduleEntry } from '../types/database'
import { daysBetween } from './dates'

export interface Balance {
  vacation: number
  personal: number
  holiday: number
  rest: number
}

export function consumedFromRequests(
  requests: DayRequest[],
  employeeId: string,
  year: number,
): Pick<Balance, 'vacation' | 'personal' | 'holiday'> {
  const yearPrefix = `${year}-`
  let vacation = 0
  let personal = 0
  let holiday = 0
  for (const r of requests) {
    if (r.employee_id !== employeeId) continue
    if (r.status !== 'approved' && r.status !== 'pending') continue
    if (!r.start_date.startsWith(yearPrefix)) continue
    const days = daysBetween(r.start_date, r.end_date)
    if (r.type === 'vacation') vacation += days
    else if (r.type === 'personal') personal += days
    else if (r.type === 'holiday') holiday += days
  }
  return { vacation, personal, holiday }
}

/**
 * Count regular rest days (días libres) consumed by an employee in the given
 * year. Counts all 'off' entries minus those covered by an approved
 * vacation/personal/holiday request (those have their own quota).
 */
export function consumedRestDays(
  entries: ScheduleEntry[],
  requests: DayRequest[],
  employeeId: string,
  year: number,
): number {
  const yearPrefix = `${year}-`
  const requestDates = new Set<string>()
  for (const r of requests) {
    if (r.employee_id !== employeeId) continue
    if (r.status !== 'approved') continue
    let cur = r.start_date
    while (cur <= r.end_date) {
      requestDates.add(cur)
      const next = new Date(cur)
      next.setDate(next.getDate() + 1)
      cur = next.toISOString().slice(0, 10)
    }
  }
  let count = 0
  for (const e of entries) {
    if (e.employee_id !== employeeId) continue
    if (e.shift !== 'off') continue
    if (!e.date.startsWith(yearPrefix)) continue
    if (requestDates.has(e.date)) continue
    count += 1
  }
  return count
}

export function remainingBalance(
  settings: GlobalSettings,
  consumed: Pick<Balance, 'vacation' | 'personal' | 'holiday'> & { rest?: number },
): Balance {
  return {
    vacation: settings.vacation_days_per_year - consumed.vacation,
    personal: settings.personal_days_per_year - consumed.personal,
    holiday: settings.holiday_days_per_year - consumed.holiday,
    rest: settings.rest_days_per_year - (consumed.rest ?? 0),
  }
}
