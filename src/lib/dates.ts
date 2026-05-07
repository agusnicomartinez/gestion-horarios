import {
  addDays,
  endOfMonth,
  format,
  getDay,
  isWithinInterval,
  parseISO,
  startOfMonth,
  startOfWeek,
  endOfWeek,
  isSameDay,
  differenceInCalendarDays,
} from 'date-fns'

export const ISO = 'yyyy-MM-dd'

export function todayISO(): string {
  return format(new Date(), ISO)
}

export function toISO(d: Date): string {
  return format(d, ISO)
}

export function fromISO(s: string): Date {
  return parseISO(s)
}

export function monthKey(d: Date): string {
  return format(d, 'yyyy-MM-01')
}

export function nextMonth(d: Date): Date {
  const result = new Date(d)
  result.setMonth(result.getMonth() + 1)
  return result
}

export function eachDayInMonth(d: Date): Date[] {
  const start = startOfMonth(d)
  const end = endOfMonth(d)
  const days: Date[] = []
  for (let cur = start; cur <= end; cur = addDays(cur, 1)) {
    days.push(new Date(cur))
  }
  return days
}

export function isWeekend(d: Date): boolean {
  const day = getDay(d)
  return day === 0 || day === 6
}

export function inclusiveRange(start: Date, end: Date): Date[] {
  const days: Date[] = []
  for (let cur = start; cur <= end; cur = addDays(cur, 1)) {
    days.push(new Date(cur))
  }
  return days
}

export function inclusiveRangeISO(startISO: string, endISO: string): string[] {
  return inclusiveRange(fromISO(startISO), fromISO(endISO)).map(toISO)
}

export function daysBetween(startISO: string, endISO: string): number {
  return differenceInCalendarDays(fromISO(endISO), fromISO(startISO)) + 1
}

export {
  addDays,
  endOfMonth,
  format,
  isWithinInterval,
  startOfMonth,
  startOfWeek,
  endOfWeek,
  isSameDay,
  parseISO,
}

/**
 * Request window: employees can submit from day 1 00:00 through day 10
 * (inclusive — closes day 11 00:00) of each month for the FOLLOWING month.
 * The server-truth-less version (localStorage v0) uses the client clock —
 * fine for a single-device app.
 */
export interface WindowState {
  open: boolean
  targetMonth: string
  opensAt: Date
  closesAt: Date
  reason?: 'before' | 'after'
}

export function requestWindow(now: Date = new Date()): WindowState {
  const y = now.getFullYear()
  const m = now.getMonth()
  const opensAt = new Date(y, m, 1, 0, 0, 0)
  const closesAt = new Date(y, m, 11, 0, 0, 0)
  const targetMonth = monthKey(new Date(y, m + 1, 1))
  if (now < opensAt) return { open: false, targetMonth, opensAt, closesAt, reason: 'before' }
  if (now >= closesAt) return { open: false, targetMonth, opensAt, closesAt, reason: 'after' }
  return { open: true, targetMonth, opensAt, closesAt }
}

/**
 * Supervisor review window: day 12 → 15. After day 15 the schedule is auto-published.
 */
export interface ReviewWindowState {
  inReview: boolean
  targetMonth: string
  startsAt: Date
  publishesAt: Date
}

export function reviewWindow(now: Date = new Date()): ReviewWindowState {
  const y = now.getFullYear()
  const m = now.getMonth()
  const startsAt = new Date(y, m, 12, 0, 0, 0)
  const publishesAt = new Date(y, m, 15, 0, 0, 0)
  const targetMonth = monthKey(new Date(y, m + 1, 1))
  return {
    inReview: now >= startsAt && now < publishesAt,
    targetMonth,
    startsAt,
    publishesAt,
  }
}
