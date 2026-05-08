import { useEffect, useMemo, useState, type FormEvent } from 'react'
import { db } from '../../lib/db'
import type {
  Category,
  CoverageOverride,
  Department,
  WorkShift,
} from '../../types/database'

const SHIFT_LABEL: Record<WorkShift, string> = {
  morning: 'Mañana',
  afternoon: 'Tarde',
  night: 'Noche',
  partido: 'Partido',
}

interface FormState {
  category_id: string
  shift: WorkShift
  start_date: string
  end_date: string
  min: string
  max: string
  notes: string
  editingId?: string
}

export default function Peaks() {
  const [departments, setDepartments] = useState<Department[]>([])
  const [categories, setCategories] = useState<Category[]>([])
  const [overrides, setOverrides] = useState<CoverageOverride[]>([])
  const [scope, setScope] = useState<string>('')
  const [formOpen, setFormOpen] = useState(false)
  const [form, setForm] = useState<FormState | null>(null)
  const [busy, setBusy] = useState(false)

  async function reload() {
    const [ds, cs, os] = await Promise.all([
      db.departments.list(),
      db.categories.list(),
      db.coverageOverrides.list(),
    ])
    setDepartments(ds)
    setCategories(cs)
    setOverrides(os)
    if (!scope && ds.length > 0) setScope(`dept:${ds[0].id}`)
  }

  useEffect(() => {
    reload()
  }, [])

  const scopeCategories = useMemo(() => {
    if (!scope) return [] as Category[]
    const [kind, id] = scope.split(':')
    if (kind === 'cat') {
      const cat = categories.find((c) => c.id === id)
      return cat ? [cat] : []
    }
    return categories.filter((c) => c.department_id === id)
  }, [categories, scope])

  // Categories available in the form selector — when scope is a single
  // category we still allow picking any of the department's categories.
  const formCategories = useMemo(() => {
    if (!scope) return [] as Category[]
    const [kind, id] = scope.split(':')
    const deptId =
      kind === 'cat' ? categories.find((c) => c.id === id)?.department_id ?? '' : id
    return categories.filter((c) => c.department_id === deptId)
  }, [categories, scope])

  const filtered = useMemo(() => {
    const catIds = new Set(scopeCategories.map((c) => c.id))
    return [...overrides]
      .filter((o) => catIds.has(o.category_id))
      .sort((a, b) => a.start_date.localeCompare(b.start_date))
  }, [overrides, scopeCategories])

  function openCreate() {
    if (formCategories.length === 0) return
    const preselected =
      scope.startsWith('cat:') ? scope.slice(4) : formCategories[0].id
    setForm({
      category_id: preselected,
      shift: 'morning',
      start_date: new Date().toISOString().slice(0, 10),
      end_date: new Date().toISOString().slice(0, 10),
      min: '',
      max: '',
      notes: '',
    })
    setFormOpen(true)
  }

  function openEdit(o: CoverageOverride) {
    setForm({
      editingId: o.id,
      category_id: o.category_id,
      shift: o.shift,
      start_date: o.start_date,
      end_date: o.end_date,
      min: o.min === null ? '' : String(o.min),
      max: o.max === null ? '' : String(o.max),
      notes: o.notes,
    })
    setFormOpen(true)
  }

  async function onSave(e: FormEvent) {
    e.preventDefault()
    if (!form) return
    if (form.end_date < form.start_date) {
      alert('La fecha "Hasta" debe ser igual o posterior a "Desde".')
      return
    }
    if (form.min === '' && form.max === '') {
      alert('Cargá al menos un mínimo o un máximo.')
      return
    }
    setBusy(true)
    try {
      const payload = {
        category_id: form.category_id,
        shift: form.shift,
        start_date: form.start_date,
        end_date: form.end_date,
        min: form.min === '' ? null : Math.max(0, Number(form.min)),
        max: form.max === '' ? null : Math.max(0, Number(form.max)),
        notes: form.notes.trim(),
      }
      if (form.editingId) {
        await db.coverageOverrides.update(form.editingId, payload)
      } else {
        await db.coverageOverrides.insert({
          ...payload,
          created_at: new Date().toISOString(),
        })
      }
      setFormOpen(false)
      setForm(null)
      await reload()
    } finally {
      setBusy(false)
    }
  }

  async function onDelete(o: CoverageOverride) {
    if (!confirm('Borrar este pico de demanda?')) return
    await db.coverageOverrides.remove(o.id)
    reload()
  }

  return (
    <section>
      <header className="section-head">
        <h1>Picos de demanda</h1>
        <div className="actions">
          <select value={scope} onChange={(e) => setScope(e.target.value)}>
            {departments.length === 0 && <option value="">— sin departamentos —</option>}
            {departments.map((d) => {
              const deptCats = categories.filter((c) => c.department_id === d.id)
              return (
                <optgroup key={d.id} label={d.name}>
                  <option value={`dept:${d.id}`}>{d.name} (todas)</option>
                  {deptCats.map((c) => (
                    <option key={c.id} value={`cat:${c.id}`}>
                      &nbsp;&nbsp;↳ {c.name}
                    </option>
                  ))}
                </optgroup>
              )
            })}
          </select>
          <button onClick={openCreate} disabled={formCategories.length === 0}>
            + Nuevo
          </button>
        </div>
      </header>

      <p className="muted small">
        Reemplazá la cobertura mínima por categoría en un rango de fechas
        específico. Lo que cargues acá se aplica automáticamente cuando
        regenerás el cronograma del mes correspondiente.
      </p>

      {formOpen && form && (
        <form className="card form" onSubmit={onSave}>
          <h2>{form.editingId ? 'Editar pico' : 'Nuevo pico'}</h2>
          <label>
            Categoría
            <select
              value={form.category_id}
              onChange={(e) => setForm({ ...form, category_id: e.target.value })}
            >
              {formCategories.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
          </label>
          <label>
            Turno
            <select
              value={form.shift}
              onChange={(e) => setForm({ ...form, shift: e.target.value as WorkShift })}
            >
              <option value="morning">Mañana</option>
              <option value="afternoon">Tarde</option>
              <option value="night">Noche</option>
              <option value="partido">Partido</option>
            </select>
          </label>
          <label>
            Desde
            <input
              type="date"
              value={form.start_date}
              onChange={(e) => setForm({ ...form, start_date: e.target.value })}
            />
          </label>
          <label>
            Hasta
            <input
              type="date"
              value={form.end_date}
              onChange={(e) => setForm({ ...form, end_date: e.target.value })}
            />
          </label>
          <div className="coverage-grid">
            <label>
              <span>Mínimo</span>
              <input
                type="number"
                min={0}
                value={form.min}
                placeholder="—"
                onChange={(e) => setForm({ ...form, min: e.target.value })}
              />
            </label>
            <label>
              <span>Máximo</span>
              <input
                type="number"
                min={0}
                value={form.max}
                placeholder="—"
                onChange={(e) => setForm({ ...form, max: e.target.value })}
              />
            </label>
          </div>
          <label>
            Notas (opcional)
            <input
              value={form.notes}
              placeholder="Ej. evento corporativo, pico de ocupación, obra X"
              onChange={(e) => setForm({ ...form, notes: e.target.value })}
            />
          </label>
          <div className="actions">
            <button
              type="button"
              className="link"
              onClick={() => {
                setFormOpen(false)
                setForm(null)
              }}
            >
              Cancelar
            </button>
            <button type="submit" disabled={busy}>
              {busy ? 'Guardando...' : 'Guardar'}
            </button>
          </div>
        </form>
      )}

      <ul className="list">
        {filtered.length === 0 && (
          <li className="muted">Sin picos cargados para este departamento.</li>
        )}
        {filtered.map((o) => {
          const cat = categories.find((c) => c.id === o.category_id)
          return (
            <li key={o.id} className="row">
              <div>
                <strong>
                  {cat?.name ?? '—'} · {SHIFT_LABEL[o.shift]}
                </strong>
                <div className="muted small">
                  {o.start_date} → {o.end_date}
                  {o.min !== null && ` · mín ${o.min}`}
                  {o.max !== null && ` · máx ${o.max}`}
                </div>
                {o.notes && <div className="muted small">📝 {o.notes}</div>}
              </div>
              <div className="actions">
                <button className="link" onClick={() => openEdit(o)}>
                  Editar
                </button>
                <button className="link danger" onClick={() => onDelete(o)}>
                  Eliminar
                </button>
              </div>
            </li>
          )
        })}
      </ul>
    </section>
  )
}
