import { useEffect, useMemo, useState, type FormEvent } from 'react'
import { db } from '../../lib/db'
import type { Category, Department, Employee, WorkShift } from '../../types/database'

const ALL_SHIFTS: { id: WorkShift; label: string }[] = [
  { id: 'morning', label: 'Mañana' },
  { id: 'afternoon', label: 'Tarde' },
  { id: 'night', label: 'Noche' },
  { id: 'partido', label: 'Partido' },
]

export default function Employees() {
  const [list, setList] = useState<Employee[]>([])
  const [departments, setDepartments] = useState<Department[]>([])
  const [categories, setCategories] = useState<Category[]>([])
  const [editing, setEditing] = useState<Employee | null>(null)
  const [showForm, setShowForm] = useState(false)
  const [filterCat, setFilterCat] = useState<string>('all')

  async function reload() {
    setList(await db.employees.list())
    setDepartments(await db.departments.list())
    setCategories(await db.categories.list())
  }

  useEffect(() => {
    reload()
  }, [])

  async function onDelete(emp: Employee) {
    if (!confirm(`¿Eliminar a ${emp.full_name}?`)) return
    await db.employees.remove(emp.id)
    reload()
  }

  async function onToggleActive(emp: Employee) {
    await db.employees.update(emp.id, { active: !emp.active })
    reload()
  }

  const catName = (id: string | null): string => {
    const c = categories.find((x) => x.id === id)
    if (!c) return '—'
    const d = departments.find((x) => x.id === c.department_id)
    return d ? `${d.name} · ${c.name}` : c.name
  }

  const filtered = useMemo(() => {
    if (filterCat === 'all') return list
    return list.filter((e) => e.category_id === filterCat)
  }, [list, filterCat])

  return (
    <section>
      <header className="section-head">
        <h1>Empleados</h1>
        <div className="actions">
          <select value={filterCat} onChange={(e) => setFilterCat(e.target.value)}>
            <option value="all">Todas las categorías</option>
            {categories.map((c) => {
              const d = departments.find((x) => x.id === c.department_id)
              return (
                <option key={c.id} value={c.id}>
                  {d ? `${d.name} · ${c.name}` : c.name}
                </option>
              )
            })}
          </select>
          <button onClick={() => { setEditing(null); setShowForm(true) }}>+ Nuevo</button>
        </div>
      </header>

      {showForm && (
        <EmployeeForm
          initial={editing}
          departments={departments}
          categories={categories}
          onCancel={() => setShowForm(false)}
          onSave={async () => { setShowForm(false); reload() }}
        />
      )}

      <ul className="list">
        {filtered.length === 0 && <li className="muted">No hay empleados en esta categoría.</li>}
        {filtered.map((e) => (
          <li key={e.id} className="row">
            <div>
              <strong>{e.full_name}</strong>
              <div className="muted small">
                DNI {e.dni} · Turnos: {labelShifts(e.shifts)} · {catName(e.category_id)}
              </div>
            </div>
            <div className="actions">
              <button className="link" onClick={() => onToggleActive(e)}>
                {e.active ? 'Desactivar' : 'Activar'}
              </button>
              <button className="link" onClick={() => { setEditing(e); setShowForm(true) }}>
                Editar
              </button>
              <button className="link danger" onClick={() => onDelete(e)}>
                Eliminar
              </button>
            </div>
          </li>
        ))}
      </ul>
    </section>
  )
}

function labelShifts(shifts: WorkShift[] | undefined): string {
  if (!shifts || shifts.length === 0) return 'sin asignar'
  if (shifts.length === ALL_SHIFTS.length) return 'todos'
  return shifts
    .map((s) => ALL_SHIFTS.find((x) => x.id === s)?.label.toLowerCase() ?? s)
    .join(', ')
}

function EmployeeForm({
  initial,
  departments,
  categories,
  onCancel,
  onSave,
}: {
  initial: Employee | null
  departments: Department[]
  categories: Category[]
  onCancel: () => void
  onSave: () => void
}) {
  const [dni, setDni] = useState(initial?.dni ?? '')
  const [name, setName] = useState(initial?.full_name ?? '')
  const [shifts, setShifts] = useState<WorkShift[]>(
    initial?.shifts ?? ['morning', 'afternoon'],
  )
  const [active, setActive] = useState(initial?.active ?? true)
  const [categoryId, setCategoryId] = useState<string>(
    initial?.category_id ?? categories[0]?.id ?? '',
  )
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  function toggleShift(s: WorkShift) {
    setShifts((prev) =>
      prev.includes(s) ? prev.filter((x) => x !== s) : [...prev, s],
    )
  }

  async function onSubmit(e: FormEvent) {
    e.preventDefault()
    setError(null)
    if (!dni.trim() || !name.trim()) {
      setError('DNI y nombre son obligatorios')
      return
    }
    if (!categoryId) {
      setError('Asignale una categoría (creala en Ajustes si no existe)')
      return
    }
    if (shifts.length === 0) {
      setError('Tildá al menos un turno que pueda hacer')
      return
    }
    setBusy(true)
    try {
      if (initial) {
        await db.employees.update(initial.id, {
          dni: dni.trim().toUpperCase(),
          full_name: name.trim(),
          shifts,
          active,
          category_id: categoryId,
        })
      } else {
        const all = await db.employees.list()
        if (all.some((x) => x.dni.toUpperCase() === dni.trim().toUpperCase())) {
          setError('Ya existe un empleado con ese DNI')
          setBusy(false)
          return
        }
        await db.employees.insert({
          dni: dni.trim().toUpperCase(),
          full_name: name.trim(),
          shifts,
          active,
          category_id: categoryId,
          created_at: new Date().toISOString(),
        })
      }
      onSave()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Error al guardar')
      setBusy(false)
    }
  }

  return (
    <form className="card form" onSubmit={onSubmit}>
      <label>DNI<input value={dni} onChange={(e) => setDni(e.target.value)} required /></label>
      <label>Nombre<input value={name} onChange={(e) => setName(e.target.value)} required /></label>
      <label>
        Categoría
        <select value={categoryId} onChange={(e) => setCategoryId(e.target.value)}>
          <option value="">— elegir —</option>
          {categories.map((c) => {
            const d = departments.find((x) => x.id === c.department_id)
            return (
              <option key={c.id} value={c.id}>
                {d ? `${d.name} · ${c.name}` : c.name}
              </option>
            )
          })}
        </select>
      </label>
      <fieldset className="shift-checkboxes">
        <legend>Turnos que puede hacer</legend>
        {ALL_SHIFTS.map((s) => (
          <label key={s.id} className="check">
            <input
              type="checkbox"
              checked={shifts.includes(s.id)}
              onChange={() => toggleShift(s.id)}
            />
            {s.label}
          </label>
        ))}
      </fieldset>
      <label className="check">
        <input type="checkbox" checked={active} onChange={(e) => setActive(e.target.checked)} /> Activo
      </label>
      {error && <p className="error">{error}</p>}
      <div className="actions">
        <button type="button" className="link" onClick={onCancel}>Cancelar</button>
        <button type="submit" disabled={busy}>{busy ? 'Guardando...' : 'Guardar'}</button>
      </div>
    </form>
  )
}
