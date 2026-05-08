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

export interface CoverageOverride {
  id: string
  category_id: string
  shift: WorkShift
  start_date: string
  end_date: string
  min: number | null
  max: number | null
  notes: string
  created_at: string
}

export interface ShiftBounds {
  min: number
  /** null = sin tope (puede crecer si hay empleados forzados). */
  max: number | null
}

export interface Category {
  id: string
  department_id: string
  name: string
  coverage: {
    morning: ShiftBounds
    afternoon: ShiftBounds
    night: ShiftBounds
    partido: ShiftBounds
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
  /** Hour (0-23) at which this employee's "partido" shift starts. End time
   *  is always start + 8h. Only relevant if `shifts` includes 'partido'. */
  partido_start_hour: number
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
  /** Total horas de trabajo efectivo al año por empleado (objetivo de
   *  cómputo). Vacaciones / festivos / días personales / bajas no suman
   *  ni restan; el objetivo mensual se ajusta proporcionalmente. */
  annual_work_hours: number
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
