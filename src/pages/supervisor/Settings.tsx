import { useEffect, useState, type FormEvent } from 'react'
import { db, DEFAULT_CONVENTION } from '../../lib/db'
import type {
  Category,
  ConventionSettings,
  Department,
  GlobalSettings,
  PublicHoliday,
} from '../../types/database'

export default function Settings() {
  const [settings, setSettings] = useState<GlobalSettings | null>(null)
  const [holidays, setHolidays] = useState<PublicHoliday[]>([])
  const [vacation, setVacation] = useState(0)
  const [personal, setPersonal] = useState(0)
  const [holidayDays, setHolidayDays] = useState(0)
  const [annualHours, setAnnualHours] = useState(0)
  const [convention, setConvention] = useState<ConventionSettings>(DEFAULT_CONVENTION)
  const [savingConvention, setSavingConvention] = useState(false)
  const [savingSettings, setSavingSettings] = useState(false)
  const [newDate, setNewDate] = useState('')
  const [newDescription, setNewDescription] = useState('')
  const [departments, setDepartments] = useState<Department[]>([])
  const [categories, setCategories] = useState<Category[]>([])
  const [newDeptName, setNewDeptName] = useState('')
  const [newCatName, setNewCatName] = useState('')
  const [newCatDept, setNewCatDept] = useState('')

  async function reload() {
    const s = await db.settings.get()
    setSettings(s)
    setVacation(s.vacation_days_per_year)
    setPersonal(s.personal_days_per_year)
    setHolidayDays(s.holiday_days_per_year)
    setAnnualHours(s.annual_work_hours)
    setConvention(s.convention ?? DEFAULT_CONVENTION)
    const h = await db.publicHolidays.list()
    h.sort((a, b) => a.date.localeCompare(b.date))
    setHolidays(h)
    const ds = await db.departments.list()
    ds.sort((a, b) => a.name.localeCompare(b.name))
    setDepartments(ds)
    const cs = await db.categories.list()
    cs.sort((a, b) => a.name.localeCompare(b.name))
    setCategories(cs)
    if (!newCatDept && ds.length > 0) setNewCatDept(ds[0].id)
  }

  async function onAddDept(e: FormEvent) {
    e.preventDefault()
    if (!newDeptName.trim()) return
    await db.departments.insert({
      name: newDeptName.trim(),
      created_at: new Date().toISOString(),
    })
    setNewDeptName('')
    reload()
  }

  async function onRenameDept(d: Department) {
    const name = prompt('Nuevo nombre del departamento', d.name)
    if (!name || !name.trim()) return
    await db.departments.update(d.id, { name: name.trim() })
    reload()
  }

  async function onDeleteDept(d: Department) {
    const cats = categories.filter((c) => c.department_id === d.id)
    if (cats.length > 0) {
      alert(`No podés borrar "${d.name}" porque tiene ${cats.length} categoría(s) asignada(s). Borralas o moveelas primero.`)
      return
    }
    if (!confirm(`Borrar departamento "${d.name}"?`)) return
    await db.departments.remove(d.id)
    reload()
  }

  async function onAddCat(e: FormEvent) {
    e.preventDefault()
    if (!newCatName.trim() || !newCatDept) return
    await db.categories.insert({
      department_id: newCatDept,
      name: newCatName.trim(),
      coverage: {
        morning: { min: 1, max: null },
        afternoon: { min: 1, max: 1 },
        night: { min: 0, max: 0 },
        partido: { min: 0, max: 0 },
      },
      created_at: new Date().toISOString(),
    })
    setNewCatName('')
    reload()
  }

  async function onRenameCat(c: Category) {
    const name = prompt('Nuevo nombre de la categoría', c.name)
    if (!name || !name.trim()) return
    await db.categories.update(c.id, { name: name.trim() })
    reload()
  }

  async function onDeleteCat(c: Category) {
    const employees = await db.employees.list()
    const linked = employees.filter((e) => e.category_id === c.id)
    if (linked.length > 0) {
      alert(`No podés borrar "${c.name}" porque tiene ${linked.length} empleado(s) asignado(s). Cambialos de categoría primero.`)
      return
    }
    if (!confirm(`Borrar categoría "${c.name}"?`)) return
    await db.categories.remove(c.id)
    reload()
  }

  async function onUpdateCoverage(
    c: Category,
    field: keyof Category['coverage'],
    bound: 'min' | 'max',
    value: string,
  ) {
    const trimmed = value.trim()
    let nextValue: number | null
    if (bound === 'max' && trimmed === '') {
      nextValue = null
    } else {
      const n = Number(trimmed)
      if (Number.isNaN(n)) return
      nextValue = Math.max(0, Math.floor(n))
    }
    await db.categories.update(c.id, {
      coverage: {
        ...c.coverage,
        [field]: { ...c.coverage[field], [bound]: nextValue },
      },
    })
    reload()
  }

  useEffect(() => {
    reload()
  }, [])

  async function onSaveSettings(e: FormEvent) {
    e.preventDefault()
    setSavingSettings(true)
    await db.settings.update({
      vacation_days_per_year: vacation,
      personal_days_per_year: personal,
      holiday_days_per_year: holidayDays,
      annual_work_hours: annualHours,
    })
    setSavingSettings(false)
    reload()
  }

  function validateConvention(c: ConventionSettings): string | null {
    if (c.min_consecutive_work_days > c.max_consecutive_work_days)
      return 'El mínimo de días seguidos no puede superar al máximo.'
    if (c.min_rest_days > c.max_rest_days)
      return 'El mínimo de descanso no puede superar al máximo.'
    if (c.rest_after_max_stretch < c.min_rest_days)
      return 'El descanso tras ciclo máximo no puede ser menor al mínimo de descanso.'
    if (c.min_hours_between_shifts < 0 || c.min_hours_between_shifts > 24)
      return 'Las horas entre turnos deben estar entre 0 y 24.'
    return null
  }

  async function onSaveConvention(e: FormEvent) {
    e.preventDefault()
    const err = validateConvention(convention)
    if (err) {
      alert(err)
      return
    }
    setSavingConvention(true)
    await db.settings.update({ convention })
    setSavingConvention(false)
    reload()
  }

  async function onResetConvention() {
    if (
      !confirm(
        'Restablecer las reglas duras al convenio por defecto? Esto sobrescribe los valores actuales.',
      )
    )
      return
    setConvention(DEFAULT_CONVENTION)
    setSavingConvention(true)
    await db.settings.update({ convention: DEFAULT_CONVENTION })
    setSavingConvention(false)
    reload()
  }

  function updateConvention<K extends keyof ConventionSettings>(
    key: K,
    value: ConventionSettings[K],
  ) {
    setConvention((c) => ({ ...c, [key]: value }))
  }

  async function onAddHoliday(e: FormEvent) {
    e.preventDefault()
    if (!newDate) return
    await db.publicHolidays.insert({ date: newDate, description: newDescription })
    setNewDate('')
    setNewDescription('')
    reload()
  }

  async function onRemoveHoliday(id: string) {
    await db.publicHolidays.remove(id)
    reload()
  }

  if (!settings) return <p>Cargando...</p>

  return (
    <section>
      <h1>Ajustes</h1>

      <form className="card form" onSubmit={onSaveSettings}>
        <h2>Parámetros globales</h2>
        <label>
          Vacaciones / año
          <input type="number" min={0} value={vacation} onChange={(e) => setVacation(+e.target.value)} />
        </label>
        <label>
          Días personales / año
          <input type="number" min={0} value={personal} onChange={(e) => setPersonal(+e.target.value)} />
        </label>
        <label>
          Festivos / año
          <input type="number" min={0} value={holidayDays} onChange={(e) => setHolidayDays(+e.target.value)} />
        </label>
        <label>
          Horas de trabajo / año
          <input
            type="number"
            min={0}
            step={1}
            value={annualHours}
            onChange={(e) => setAnnualHours(+e.target.value)}
          />
          <span className="muted small">
            Horas efectivas al año por empleado. Objetivo mensual ≈ {(annualHours / 12).toFixed(0)} h
            (~{Math.round(annualHours / 12 / 8)} jornadas). Vacaciones, festivos, días personales y bajas
            no suman: el objetivo del mes se ajusta proporcionalmente. Tolerancia ±16 h.
          </span>
        </label>
        <div className="actions">
          <button type="submit" disabled={savingSettings}>
            {savingSettings ? 'Guardando...' : 'Guardar'}
          </button>
        </div>
      </form>

      <form className="card form" onSubmit={onSaveConvention}>
        <h2>Reglas del convenio</h2>
        <p className="muted small">
          Restricciones inviolables que aplica el generador de cronogramas. Cambialas
          sólo si cambia formalmente el convenio.
        </p>
        <label>
          Días consecutivos máximos de trabajo
          <input
            type="number"
            min={1}
            value={convention.max_consecutive_work_days}
            onChange={(e) =>
              updateConvention('max_consecutive_work_days', +e.target.value)
            }
          />
        </label>
        <label>
          Días consecutivos mínimos de trabajo
          <input
            type="number"
            min={1}
            value={convention.min_consecutive_work_days}
            onChange={(e) =>
              updateConvention('min_consecutive_work_days', +e.target.value)
            }
          />
        </label>
        <label>
          Días mínimos de descanso entre ciclos
          <input
            type="number"
            min={1}
            value={convention.min_rest_days}
            onChange={(e) => updateConvention('min_rest_days', +e.target.value)}
          />
        </label>
        <label>
          Días máximos de descanso entre ciclos
          <input
            type="number"
            min={1}
            value={convention.max_rest_days}
            onChange={(e) => updateConvention('max_rest_days', +e.target.value)}
          />
        </label>
        <label>
          Descanso tras ciclo máximo (días)
          <input
            type="number"
            min={1}
            value={convention.rest_after_max_stretch}
            onChange={(e) =>
              updateConvention('rest_after_max_stretch', +e.target.value)
            }
          />
        </label>
        <label>
          Horas mínimas entre turnos
          <input
            type="number"
            min={0}
            max={24}
            value={convention.min_hours_between_shifts}
            onChange={(e) =>
              updateConvention('min_hours_between_shifts', +e.target.value)
            }
          />
        </label>
        <label className="checkbox">
          <input
            type="checkbox"
            checked={convention.require_full_weekend_off_monthly}
            onChange={(e) =>
              updateConvention('require_full_weekend_off_monthly', e.target.checked)
            }
          />
          Cada empleado debe tener un fin de semana completo libre al mes
        </label>
        <div className="actions">
          <button type="submit" disabled={savingConvention}>
            {savingConvention ? 'Guardando...' : 'Guardar convenio'}
          </button>
          <button
            type="button"
            className="ghost"
            onClick={onResetConvention}
            disabled={savingConvention}
          >
            Restablecer al convenio por defecto
          </button>
        </div>
      </form>

      <div className="card">
        <h2>Departamentos</h2>
        <form onSubmit={onAddDept} className="inline-form">
          <input
            placeholder="Nombre del departamento"
            value={newDeptName}
            onChange={(e) => setNewDeptName(e.target.value)}
          />
          <button type="submit">+ Añadir</button>
        </form>
        <ul className="list">
          {departments.length === 0 && <li className="muted">Sin departamentos.</li>}
          {departments.map((d) => {
            const catCount = categories.filter((c) => c.department_id === d.id).length
            return (
              <li key={d.id} className="row">
                <div>
                  <strong>{d.name}</strong>
                  <div className="muted small">{catCount} categoría(s)</div>
                </div>
                <div className="actions">
                  <button className="link" onClick={() => onRenameDept(d)}>Renombrar</button>
                  <button className="link danger" onClick={() => onDeleteDept(d)}>Eliminar</button>
                </div>
              </li>
            )
          })}
        </ul>
      </div>

      <div className="card">
        <h2>Categorías</h2>
        <form onSubmit={onAddCat} className="inline-form">
          <select value={newCatDept} onChange={(e) => setNewCatDept(e.target.value)}>
            {departments.map((d) => (
              <option key={d.id} value={d.id}>{d.name}</option>
            ))}
          </select>
          <input
            placeholder="Nombre de la categoría"
            value={newCatName}
            onChange={(e) => setNewCatName(e.target.value)}
          />
          <button type="submit" disabled={departments.length === 0}>+ Añadir</button>
        </form>
        <ul className="list">
          {categories.length === 0 && <li className="muted">Sin categorías.</li>}
          {categories.map((c) => {
            const dept = departments.find((d) => d.id === c.department_id)
            const cov = c.coverage ?? {
              morning: { min: 1, max: null },
              afternoon: { min: 1, max: 1 },
              night: { min: 0, max: 0 },
              partido: { min: 0, max: 0 },
            }
            const SHIFTS: { key: keyof typeof cov; label: string }[] = [
              { key: 'morning', label: 'Mañana' },
              { key: 'afternoon', label: 'Tarde' },
              { key: 'night', label: 'Noche' },
              { key: 'partido', label: 'Partido' },
            ]
            return (
              <li key={c.id} className="row category-row">
                <div className="grow">
                  <strong>{c.name}</strong>
                  <div className="muted small">Departamento: {dept?.name ?? '—'}</div>
                  <table className="bounds-table">
                    <thead>
                      <tr>
                        <th></th>
                        <th>Mín</th>
                        <th>Máx</th>
                      </tr>
                    </thead>
                    <tbody>
                      {SHIFTS.map((s) => {
                        const b = cov[s.key]
                        return (
                          <tr key={s.key}>
                            <td className="bounds-label">{s.label}</td>
                            <td>
                              <input
                                type="number"
                                min={0}
                                value={b.min}
                                onChange={(e) => onUpdateCoverage(c, s.key, 'min', e.target.value)}
                              />
                            </td>
                            <td>
                              <input
                                type="number"
                                min={0}
                                value={b.max ?? ''}
                                placeholder="—"
                                onChange={(e) => onUpdateCoverage(c, s.key, 'max', e.target.value)}
                              />
                            </td>
                          </tr>
                        )
                      })}
                    </tbody>
                  </table>
                  <div className="muted small">Máx vacío = sin tope (puede crecer si hay empleados forzados).</div>
                </div>
                <div className="actions">
                  <button className="link" onClick={() => onRenameCat(c)}>Renombrar</button>
                  <button className="link danger" onClick={() => onDeleteCat(c)}>Eliminar</button>
                </div>
              </li>
            )
          })}
        </ul>
      </div>

      <div className="card">
        <h2>Festivos</h2>
        <form onSubmit={onAddHoliday} className="inline-form">
          <input type="date" value={newDate} onChange={(e) => setNewDate(e.target.value)} required />
          <input
            placeholder="Descripción"
            value={newDescription}
            onChange={(e) => setNewDescription(e.target.value)}
          />
          <button type="submit">+ Añadir</button>
        </form>
        <ul className="list">
          {holidays.length === 0 && <li className="muted">Sin festivos cargados.</li>}
          {holidays.map((h) => (
            <li key={h.id} className="row">
              <div>
                <strong>{h.date}</strong>
                <div className="muted small">{h.description || '—'}</div>
              </div>
              <button className="link danger" onClick={() => onRemoveHoliday(h.id)}>Eliminar</button>
            </li>
          ))}
        </ul>
      </div>
    </section>
  )
}
