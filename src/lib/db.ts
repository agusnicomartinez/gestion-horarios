import type {
  Category,
  CoverageOverride,
  DayRequest,
  Department,
  Employee,
  GlobalSettings,
  PublicHoliday,
  Schedule,
  ScheduleEntry,
  Supervisor,
} from '../types/database'

const PREFIX = 'gh:'

function read<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(PREFIX + key)
    return raw ? (JSON.parse(raw) as T) : fallback
  } catch {
    return fallback
  }
}

function write<T>(key: string, value: T): void {
  localStorage.setItem(PREFIX + key, JSON.stringify(value))
}

function uid(): string {
  return crypto.randomUUID()
}

interface Row {
  id: string
}

function tableOf<T extends Row>(key: string) {
  return {
    async list(): Promise<T[]> {
      return read<T[]>(key, [])
    },
    async byId(id: string): Promise<T | null> {
      const all = read<T[]>(key, [])
      return all.find((r) => r.id === id) ?? null
    },
    async insert(input: Omit<T, 'id'>): Promise<T> {
      const all = read<T[]>(key, [])
      const row = { ...input, id: uid() } as unknown as T
      write(key, [...all, row])
      return row
    },
    async update(id: string, patch: Partial<T>): Promise<T> {
      const all = read<T[]>(key, [])
      const idx = all.findIndex((r) => r.id === id)
      if (idx === -1) throw new Error(`Not found: ${key}/${id}`)
      const updated = { ...all[idx], ...patch, id } as T
      all[idx] = updated
      write(key, all)
      return updated
    },
    async remove(id: string): Promise<void> {
      const all = read<T[]>(key, [])
      write(
        key,
        all.filter((r) => r.id !== id),
      )
    },
    async insertMany(inputs: Omit<T, 'id'>[]): Promise<T[]> {
      const all = read<T[]>(key, [])
      const rows = inputs.map((input) => ({ ...input, id: uid() } as unknown as T))
      write(key, [...all, ...rows])
      return rows
    },
    async removeWhere(predicate: (r: T) => boolean): Promise<number> {
      const all = read<T[]>(key, [])
      const kept = all.filter((r) => !predicate(r))
      const removed = all.length - kept.length
      write(key, kept)
      return removed
    },
  }
}

const DEFAULT_SETTINGS: GlobalSettings = {
  id: 1,
  vacation_days_per_year: 31,
  personal_days_per_year: 3,
  holiday_days_per_year: 14,
  annual_work_hours: 1783,
  updated_at: new Date().toISOString(),
}

const settingsTable = {
  async get(): Promise<GlobalSettings> {
    const stored = read<Partial<GlobalSettings>>('settings', {})
    return { ...DEFAULT_SETTINGS, ...stored }
  },
  async update(patch: Partial<GlobalSettings>): Promise<GlobalSettings> {
    const current = await settingsTable.get()
    const updated: GlobalSettings = {
      ...current,
      ...patch,
      updated_at: new Date().toISOString(),
    }
    write('settings', updated)
    return updated
  },
}

export const db = {
  employees: tableOf<Employee>('employees'),
  supervisors: tableOf<Supervisor>('supervisors'),
  publicHolidays: tableOf<PublicHoliday>('public_holidays'),
  dayRequests: tableOf<DayRequest>('day_requests'),
  schedules: tableOf<Schedule>('schedules'),
  scheduleEntries: tableOf<ScheduleEntry>('schedule_entries'),
  departments: tableOf<Department>('departments'),
  categories: tableOf<Category>('categories'),
  coverageOverrides: tableOf<CoverageOverride>('coverage_overrides'),
  settings: settingsTable,
  async resetAll(): Promise<void> {
    Object.keys(localStorage)
      .filter((k) => k.startsWith(PREFIX))
      .forEach((k) => localStorage.removeItem(k))
  },
}

const SEEDED_KEY = '__seeded'

const BARCELONA_2026_HOLIDAYS: Omit<PublicHoliday, 'id'>[] = [
  { date: '2026-01-01', description: "Cap d'Any" },
  { date: '2026-01-06', description: 'Reis' },
  { date: '2026-04-03', description: 'Divendres Sant' },
  { date: '2026-04-06', description: 'Dilluns de Pasqua Florida' },
  { date: '2026-05-01', description: 'Festa del Treball' },
  { date: '2026-05-25', description: 'Pasqua Granada' },
  { date: '2026-06-24', description: 'Sant Joan' },
  { date: '2026-08-15', description: "L'Assumpció" },
  { date: '2026-09-11', description: 'Diada Nacional de Catalunya' },
  { date: '2026-09-24', description: 'La Mercè' },
  { date: '2026-10-12', description: "Festa Nacional d'Espanya" },
  { date: '2026-11-02', description: 'Tots Sants (trasllat)' },
  { date: '2026-12-08', description: 'La Immaculada' },
  { date: '2026-12-25', description: 'Nadal' },
]

export async function seedIfEmpty(): Promise<void> {
  if (read(SEEDED_KEY, false)) return
  for (const h of BARCELONA_2026_HOLIDAYS) {
    await db.publicHolidays.insert(h)
  }
  await db.settings.update({})
  write(SEEDED_KEY, true)
}

const MIGRATIONS_KEY = '__migrations'

/**
 * Idempotent migrations for the local data store. Currently:
 * - depts_categories_v1: ensures every employee has a category_id and every
 *   schedule has a department_id by creating a default "General" department
 *   + "General" category and back-filling existing rows.
 */
function shiftTypeToShifts(t: string | undefined): ('morning' | 'afternoon' | 'night' | 'partido')[] {
  switch (t) {
    case 'morning': return ['morning']
    case 'afternoon': return ['afternoon']
    case 'night': return ['night']
    case 'partido': return ['partido']
    case 'both': return ['morning', 'afternoon']
    case 'all': return ['morning', 'afternoon', 'night', 'partido']
    default: return ['morning', 'afternoon']
  }
}

type LegacyShiftBounds = number | { min?: number; max?: number | null }

function normaliseBound(v: LegacyShiftBounds | undefined, growable: boolean): { min: number; max: number | null } {
  if (v && typeof v === 'object') {
    return {
      min: v.min ?? 0,
      max: v.max === undefined ? (growable ? null : v.min ?? 0) : v.max,
    }
  }
  const n = typeof v === 'number' ? v : 0
  return { min: n, max: growable ? null : n }
}

function normaliseCoverage(raw: unknown): Category['coverage'] {
  const cov = (raw ?? {}) as Record<string, LegacyShiftBounds | undefined>
  return {
    morning: normaliseBound(cov.morning, true),
    afternoon: normaliseBound(cov.afternoon, false),
    night: normaliseBound(cov.night, false),
    partido: normaliseBound(cov.partido, false),
  }
}

function isLegacyCoverage(raw: unknown): boolean {
  if (!raw || typeof raw !== 'object') return true
  const cov = raw as Record<string, unknown>
  for (const key of ['morning', 'afternoon', 'night', 'partido']) {
    const v = cov[key]
    if (typeof v === 'number') return true
    if (!v || typeof v !== 'object') return true
  }
  return false
}

export async function runMigrations(): Promise<void> {
  const applied = read<string[]>(MIGRATIONS_KEY, [])
  const want = 'depts_categories_v1'
  const wantShifts = 'employee_shifts_array_v1'
  const wantWorkHours = 'annual_work_hours_v1'

  if (!applied.includes(wantWorkHours)) {
    // Replace rest_days_per_year with annual_work_hours = 1783.
    const stored = read<Record<string, unknown>>('settings', {})
    if ('rest_days_per_year' in stored) delete stored.rest_days_per_year
    if (!('annual_work_hours' in stored)) {
      stored.annual_work_hours = 1783
      stored.updated_at = new Date().toISOString()
    }
    write('settings', stored)

    // Default partido_start_hour=9 for all employees that don't have it.
    for (const e of await db.employees.list()) {
      const anyE = e as unknown as { partido_start_hour?: number }
      if (typeof anyE.partido_start_hour !== 'number') {
        await db.employees.update(e.id, { partido_start_hour: 9 } as Partial<Employee>)
      }
    }
  }

  let depts = await db.departments.list()
  let cats = await db.categories.list()
  let dept = depts[0]
  if (!dept) {
    dept = await db.departments.insert({
      name: 'General',
      created_at: new Date().toISOString(),
    })
    depts = [dept]
  }
  let cat = cats.find((c) => c.department_id === dept.id)
  if (!cat) {
    cat = await db.categories.insert({
      department_id: dept.id,
      name: 'General',
      coverage: {
        morning: { min: 1, max: null },
        afternoon: { min: 1, max: 1 },
        night: { min: 0, max: 0 },
        partido: { min: 0, max: 0 },
      },
      created_at: new Date().toISOString(),
    })
    cats = [cat]
  }

  // Migrate any category whose coverage is still in the legacy number-based
  // shape to { min, max } per shift. Morning gets max=null (current grow
  // behaviour); the rest get max=min (current strict behaviour).
  const allCats = await db.categories.list()
  for (const c of allCats) {
    if (isLegacyCoverage(c.coverage)) {
      await db.categories.update(c.id, { coverage: normaliseCoverage(c.coverage) })
    }
  }

  const employees = await db.employees.list()
  for (const e of employees) {
    const patch: Partial<Employee> = {}
    if (!e.category_id) patch.category_id = cat.id
    const anyEmp = e as unknown as { shifts?: string[]; shift_type?: string }
    if (!anyEmp.shifts || anyEmp.shifts.length === 0) {
      patch.shifts = shiftTypeToShifts(anyEmp.shift_type) as Employee['shifts']
    }
    if (Object.keys(patch).length > 0) await db.employees.update(e.id, patch)
  }
  const schedules = await db.schedules.list()
  for (const s of schedules) {
    if (!s.department_id) {
      await db.schedules.update(s.id, { department_id: dept.id })
    }
  }

  const next = new Set(applied)
  next.add(want)
  next.add(wantShifts)
  next.add(wantWorkHours)
  write(MIGRATIONS_KEY, [...next])
}
