export type ShiftType = 'morning' | 'afternoon' | 'both' | 'night' | 'partido' | 'all'
export type WorkShift = 'morning' | 'afternoon' | 'night' | 'partido'
export type RequestType = 'vacation' | 'personal' | 'holiday' | 'sick'
export type RequestStatus = 'pending' | 'approved' | 'rejected'
export type Shift = 'morning' | 'afternoon' | 'off' | 'vacation' | 'holiday' | 'personal' | 'sick' | 'night' | 'partido'
export type ScheduleStatus = 'draft' | 'published'
export type EntrySource = 'auto' | 'manual' | 'request'

export interface Department {
  id: string
  name: string
  created_at: string
}

export interface Category {
  id: string
  department_id: string
  name: string
  /**
   * Minimum daily coverage per shift. v0 only writes morning/afternoon.
   * Phase B will add night/partido and make these configurable.
   */
  coverage: {
    morning: number
    afternoon: number
    night: number
    partido: number
  }
  created_at: string
}

export interface Employee {
  id: string
  dni: string
  full_name: string
  /** Specific shifts this employee can be assigned to. Replaces the old
   *  shift_type enum so any combination is possible. */
  shifts: WorkShift[]
  /** @deprecated kept only for migration compatibility — use `shifts` */
  shift_type?: ShiftType
  active: boolean
  category_id: string | null
  created_at: string
}

export interface Supervisor {
  id: string
  dni: string
  full_name: string
  created_at: string
}

export interface GlobalSettings {
  id: number
  vacation_days_per_year: number
  personal_days_per_year: number
  holiday_days_per_year: number
  rest_days_per_year: number
  updated_at: string
}

export interface PublicHoliday {
  id: string
  date: string
  description: string
}

export interface DayRequest {
  id: string
  employee_id: string
  type: RequestType
  start_date: string
  end_date: string
  status: RequestStatus
  target_month: string
  created_at?: string
  reviewed_at?: string | null
  reviewed_by?: string | null
}

export interface Schedule {
  id: string
  month: string
  department_id: string | null
  status: ScheduleStatus
  created_at: string
  published_at?: string | null
}

export interface ScheduleEntry {
  id: string
  schedule_id: string
  employee_id: string
  date: string
  shift: Shift
  source: EntrySource
}
