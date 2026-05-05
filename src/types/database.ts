export type ShiftType = 'morning' | 'afternoon' | 'both'
export type RequestType = 'vacation' | 'personal' | 'holiday'
export type RequestStatus = 'pending' | 'approved' | 'rejected'
export type Shift = 'morning' | 'afternoon' | 'off'

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
  created_at: string
  reviewed_at: string | null
  reviewed_by: string | null
}

export interface ScheduleEntry {
  id: string
  employee_id: string
  date: string
  shift: Shift
  source: 'auto' | 'manual' | 'request'
  published: boolean
}

export interface Schedule {
  id: string
  month: string
  status: 'draft' | 'published'
  published_at: string | null
  created_at: string
}

export interface Database {
  public: {
    Tables: {
      employees: { Row: Employee; Insert: Omit<Employee, 'id' | 'created_at'>; Update: Partial<Employee> }
      supervisors: { Row: Supervisor; Insert: Omit<Supervisor, 'id' | 'created_at'>; Update: Partial<Supervisor> }
      global_settings: { Row: GlobalSettings; Insert: Partial<GlobalSettings>; Update: Partial<GlobalSettings> }
      public_holidays: { Row: PublicHoliday; Insert: Omit<PublicHoliday, 'id'>; Update: Partial<PublicHoliday> }
      day_requests: { Row: DayRequest; Insert: Omit<DayRequest, 'id' | 'created_at' | 'reviewed_at' | 'reviewed_by'>; Update: Partial<DayRequest> }
      schedules: { Row: Schedule; Insert: Omit<Schedule, 'id' | 'created_at' | 'published_at'>; Update: Partial<Schedule> }
      schedule_entries: { Row: ScheduleEntry; Insert: Omit<ScheduleEntry, 'id'>; Update: Partial<ScheduleEntry> }
    }
  }
}
