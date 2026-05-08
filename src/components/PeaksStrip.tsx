import { useMemo, useState, type FormEvent } from 'react'
import { format } from 'date-fns'
import { es } from 'date-fns/locale'
import { db } from '../lib/db'
import { eachDayInMonth, fromISO, toISO } from '../lib/dates'
import type {
  Category,
  CoverageOverride,
  WorkShift,
} from '../types/database'

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

interface Props {
  monthISO: string
  /** Categories the user can add picos to (department-scoped). */
  formCategories: Category[]
  /** Categories whose picos are listed (scope-narrowed). */
  scopedCategoryIds: Set<string>
  /** All overrides; component filters by scope + day. */
  overrides: CoverageOverride[]
  /** Lookup for displaying category name in any pico the strip touches. */
  allCategories: Category[]
  /** Called after any insert/update/delete so parent can reload. */
  onChange: () => void
}

export default function PeaksStrip({
  monthISO,
  formCategories,
  scopedCategoryIds,
  overrides,
  allCategories,
  onChange,
}: Props) {
  const [openDay, setOpenDay] = useState<string | null>(null)
  const [form, setForm] = useState<FormState | null>(null)
  const [busy, setBusy] = useState(false)

  const days = useMemo(() => eachDayInMonth(fromISO(monthISO)), [monthISO])

  const scopedOverrides = useMemo(
    () => overrides.filter((o) => scopedCategoryIds.has(o.category_id)),
    [overrides, scopedCategoryIds],
  )

  const countByDay = useMemo(() => {
    const m = new Map<string, number>()
    for (const d of days) {
      const dISO = toISO(d)
      const n = scopedOverrides.filter(
        (o) => dISO >= o.start_date && dISO <= o.end_date,
      ).length
      if (n > 0) m.set(dISO, n)
    }
    return m
  }, [days, scopedOverrides])

  const totalThisMonth = useMemo(() => {
    const monthStart = monthISO
    const monthEnd = toISO(
      new Date(fromISO(monthISO).getFullYear(), fromISO(monthISO).getMonth() + 1, 0),
    )
    return scopedOverrides.filter(
      (o) => o.start_date <= monthEnd && o.end_date >= monthStart,
    ).length
  }, [scopedOverrides, monthISO])

  const dayPicos = useMemo(() => {
    if (!openDay) return []
    return scopedOverrides
      .filter((o) => openDay >= o.start_date && openDay <= o.end_date)
      .sort((a, b) => a.category_id.localeCompare(b.category_id))
  }, [openDay, scopedOverrides])

  function openCreate() {
    if (!openDay || formCategories.length === 0) return
    const preselected =
      scopedCategoryIds.size === 1
        ? Array.from(scopedCategoryIds)[0]
        : formCategories[0].id
    setForm({
      category_id: preselected,
      shift: 'morning',
      start_date: openDay,
      end_date: openDay,
      min: '',
      max: '',
      notes: '',
    })
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
      setForm(null)
      onChange()
    } finally {
      setBusy(false)
    }
  }

  async function onDelete(o: CoverageOverride) {
    if (!confirm('Borrar este pico?')) return
    await db.coverageOverrides.remove(o.id)
    onChange()
  }

  const dayLabel = openDay
    ? format(fromISO(openDay), "EEEE d 'de' MMMM", { locale: es })
    : ''

  return (
    <div className="peaks-strip-wrap">
      <div className="peaks-strip-header">
        <span className="peaks-strip-title">Picos de demanda del mes</span>
        <span className="muted small">
          {totalThisMonth === 0
            ? 'sin picos cargados'
            : totalThisMonth === 1
              ? '1 pico cargado'
              : `${totalThisMonth} picos cargados`}
        </span>
      </div>
      <div className="peaks-strip">
        {days.map((d) => {
          const dISO = toISO(d)
          const count = countByDay.get(dISO) ?? 0
          const dow = ['D', 'L', 'M', 'X', 'J', 'V', 'S'][d.getDay()]
          const isWeekend = d.getDay() === 0 || d.getDay() === 6
          return (
            <button
              key={dISO}
              className={[
                'peaks-day',
                count > 0 ? 'has-peak' : '',
                isWeekend ? 'weekend' : '',
              ].join(' ')}
              onClick={() => setOpenDay(dISO)}
              title={count > 0 ? `${count} pico(s)` : 'Sin picos'}
            >
              <span className="peaks-day-num">{format(d, 'd')}</span>
              <span className="peaks-day-dow">{dow}</span>
              {count > 0 && <span className="peaks-day-badge">{count}</span>}
            </button>
          )
        })}
      </div>

      {openDay && !form && (
        <div className="modal-backdrop" onClick={() => setOpenDay(null)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <div className="cell-sheet-head">
              <div>
                <strong style={{ textTransform: 'capitalize' }}>{dayLabel}</strong>
                <div className="muted small">
                  {dayPicos.length === 0
                    ? 'Sin picos para este día'
                    : `${dayPicos.length} pico(s)`}
                </div>
              </div>
              <button className="ghost icon-only" onClick={() => setOpenDay(null)}>
                ✕
              </button>
            </div>

            {dayPicos.length > 0 && (
              <ul className="list peaks-day-list">
                {dayPicos.map((o) => {
                  const cat = allCategories.find((c) => c.id === o.category_id)
                  return (
                    <li key={o.id} className="row">
                      <div>
                        <strong>
                          {cat?.name ?? '—'} · {SHIFT_LABEL[o.shift]}
                        </strong>
                        <div className="muted small">
                          {o.start_date === o.end_date
                            ? o.start_date
                            : `${o.start_date} → ${o.end_date}`}
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
                          Borrar
                        </button>
                      </div>
                    </li>
                  )
                })}
              </ul>
            )}

            <div className="actions" style={{ justifyContent: 'flex-end', marginTop: '0.75rem' }}>
              <button onClick={openCreate} disabled={formCategories.length === 0}>
                + Nuevo pico
              </button>
            </div>
          </div>
        </div>
      )}

      {form && (
        <div className="modal-backdrop" onClick={() => !busy && setForm(null)}>
          <form className="modal" onClick={(e) => e.stopPropagation()} onSubmit={onSave}>
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
                placeholder="Ej. evento, ocupación alta, obra"
                onChange={(e) => setForm({ ...form, notes: e.target.value })}
              />
            </label>
            <div className="actions">
              <button
                type="button"
                className="link"
                onClick={() => setForm(null)}
                disabled={busy}
              >
                Cancelar
              </button>
              <button type="submit" disabled={busy}>
                {busy ? 'Guardando...' : 'Guardar'}
              </button>
            </div>
          </form>
        </div>
      )}
    </div>
  )
}
