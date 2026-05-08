import type { DayRequest, GlobalSettings } from '../types/database'
import { daysBetween } from './dates'

export interface Balance {
  vacation: number
  personal: number
  holiday: number
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

export function remainingBalance(
  settings: GlobalSettings,
  consumed: Pick<Balance, 'vacation' | 'personal' | 'holiday'>,
): Balance {
  return {
    vacation: settings.vacation_days_per_year - consumed.vacation,
    personal: settings.personal_days_per_year - consumed.personal,
    holiday: settings.holiday_days_per_year - consumed.holiday,
  }
}
