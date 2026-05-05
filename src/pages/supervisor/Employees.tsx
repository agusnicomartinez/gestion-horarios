import { useEffect, useState, type FormEvent } from 'react'
import { db } from '../../lib/db'
import type { Employee, ShiftType } from '../../types/database'

export default function Employees() {
  const [list, setList] = useState<Employee[]>([])
  const [editing, setEditing] = useState<Employee | null>(null)
  const [showForm, setShowForm] = useState(false)

  async function reload() {
    setList(await db.employees.list())
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

  return (
    <section>
      <header className="section-head">
        <h1>Empleados</h1>
        <button onClick={() => { setEditing(null); setShowForm(true) }}>+ Nuevo</button>
      </header>

      {showForm && (
        <EmployeeForm
          initial={editing}
          onCancel={() => setShowForm(false)}
          onSave={async () => { setShowForm(false); reload() }}
        />
      )}

      <ul className="list">
        {list.length === 0 && <li className="muted">No hay empleados aún.</li>}
        {list.map((e) => (
          <li key={e.id} className="row">
            <div>
              <strong>{e.full_name}</strong>
              <div className="muted small">DNI {e.dni} · Turno {labelShift(e.shift_type)}</div>
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

function labelShift(s: ShiftType): string {
  return s === 'morning' ? 'mañana' : s === 'afternoon' ? 'tarde' : 'mañana y tarde'
}

function EmployeeForm({
  initial,
  onCancel,
  onSave,
}: {
  initial: Employee | null
  onCancel: () => void
  onSave: () => void
}) {
  const [dni, setDni] = useState(initial?.dni ?? '')
  const [name, setName] = useState(initial?.full_name ?? '')
  const [shiftType, setShiftType] = useState<ShiftType>(initial?.shift_type ?? 'both')
  const [active, setActive] = useState(initial?.active ?? true)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function onSubmit(e: FormEvent) {
    e.preventDefault()
    setError(null)
    if (!dni.trim() || !name.trim()) {
      setError('DNI y nombre son obligatorios')
      return
    }
    setBusy(true)
    try {
      if (initial) {
        await db.employees.update(initial.id, {
          dni: dni.trim().toUpperCase(),
          full_name: name.trim(),
          shift_type: shiftType,
          active,
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
          shift_type: shiftType,
          active,
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
        Tipo de turno
        <select value={shiftType} onChange={(e) => setShiftType(e.target.value as ShiftType)}>
          <option value="both">Mañana y tarde</option>
          <option value="morning">Solo mañana</option>
          <option value="afternoon">Solo tarde</option>
        </select>
      </label>
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
