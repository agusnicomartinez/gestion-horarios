export type ShiftType = 'morning' | 'afternoon' | 'both'
export type RequestType = 'vacation' | 'personal' | 'holiday'
export type RequestStatus = 'pending' | 'approved' | 'rejected'
export type Shift = 'morning' | 'afternoon' | 'off'
export type ScheduleStatus = 'draft' | 'published'
export type EntrySource = 'auto' | 'manual' | 'request'

export interface Employee {
  id: string
  dni: string
  full_name: string
  shift_type: ShiftType
  active: boolean
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
