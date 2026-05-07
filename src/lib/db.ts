import type {
  Category,
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
  // 1783 h/año / 8 h/día ≈ 223 días trabajo → 365 − 223 − 31 vac − 14 festivos
  // ≈ 97 días libres regulares (~ 8 al mes).
  rest_days_per_year: 97,
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

export async function runMigrations(): Promise<void> {
  const applied = read<string[]>(MIGRATIONS_KEY, [])
  const want = 'depts_categories_v1'
  const wantShifts = 'employee_shifts_array_v1'

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
      coverage: { morning: 1, afternoon: 1, night: 0, partido: 0 },
      created_at: new Date().toISOString(),
    })
    cats = [cat]
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
  write(MIGRATIONS_KEY, [...next])
}
