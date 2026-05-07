import { useEffect, useMemo, useState } from 'react'
import { db } from '../../lib/db'
import type { DayRequest, Employee, RequestType } from '../../types/database'
import { eachDayInMonth, fromISO, toISO } from '../../lib/dates'
import { addDays, format } from 'date-fns'

interface ModalState {
  employeeId: string
  start: string
  end: string
  type: RequestType
  existingId?: string
}

type ViewMode = 'single' | 'all'

export default function Calendar() {
  const [employees, setEmployees] = useState<Employee[]>([])
  const [employeeId, setEmployeeId] = useState<string | null>(null)
  const [view, setView] = useState<ViewMode>('single')
  const [year, setYear] = useState(new Date().getFullYear())
  const [requests, setRequests] = useState<DayRequest[]>([])
  const [modal, setModal] = useState<ModalState | null>(null)
  const [busy, setBusy] = useState(false)

  async function reload() {
    const emps = (await db.employees.list()).filter((e) => e.active)
    setEmployees(emps)
    if (!employeeId && emps.length > 0) setEmployeeId(emps[0].id)
    setRequests(await db.dayRequests.list())
  }

  useEffect(() => {
    reload()
  }, [])

  const dayMap = useMemo(() => {
    const m = new Map<string, { reqId: string; type: RequestType; start: string; end: string }>()
    if (!employeeId) return m
    for (const r of requests) {
      if (r.employee_id !== employeeId) continue
      if (r.status !== 'approved') continue
      let cur = fromISO(r.start_date)
      const endDate = fromISO(r.end_date)
      while (cur <= endDate) {
        m.set(toISO(cur), {
          reqId: r.id,
          type: r.type,
          start: r.start_date,
          end: r.end_date,
        })
        cur = addDays(cur, 1)
      }
    }
    return m
  }, [requests, employeeId])

  function onCellClick(dateISO: string) {
    if (!employeeId) return
    onCellClickForEmployee(employeeId, dateISO)
  }

  function onCellClickForEmployee(empId: string, dateISO: string) {
    const req = requests.find(
      (r) =>
        r.employee_id === empId &&
        r.status === 'approved' &&
        dateISO >= r.start_date &&
        dateISO <= r.end_date,
    )
    if (req) {
      setModal({
        employeeId: empId,
        start: req.start_date,
        end: req.end_date,
        type: req.type,
        existingId: req.id,
      })
    } else {
      setModal({ employeeId: empId, start: dateISO, end: dateISO, type: 'vacation' })
    }
  }

  async function onSave() {
    if (!modal) return
    if (modal.end < modal.start) {
      alert('La fecha "Hasta" debe ser igual o posterior a "Desde".')
      return
    }
    setBusy(true)
    try {
      if (modal.existingId) {
        await db.dayRequests.update(modal.existingId, {
          type: modal.type,
          start_date: modal.start,
          end_date: modal.end,
          target_month: modal.start.slice(0, 7) + '-01',
        })
      } else {
        const overlaps = requests.filter(
          (r) =>
            r.employee_id === modal.employeeId &&
            r.status === 'approved' &&
            r.start_date <= modal.end &&
            r.end_date >= modal.start,
        )
        if (overlaps.length > 0) {
          const ok = confirm(
            `Hay ${overlaps.length} solicitud(es) que se solapan con este rango. ¿Reemplazarlas?`,
          )
          if (!ok) {
            setBusy(false)
            return
          }
          for (const c of overlaps) await db.dayRequests.remove(c.id)
        }
        await db.dayRequests.insert({
          employee_id: modal.employeeId,
          type: modal.type,
          start_date: modal.start,
          end_date: modal.end,
          status: 'approved',
          target_month: modal.start.slice(0, 7) + '-01',
        })
      }
      setModal(null)
      await reload()
    } finally {
      setBusy(false)
    }
  }

  async function onDelete() {
    if (!modal?.existingId) return
    if (!confirm('Borrar esta solicitud?')) return
    setBusy(true)
    try {
      await db.dayRequests.remove(modal.existingId)
      setModal(null)
      await reload()
    } finally {
      setBusy(false)
    }
  }

  function onAddRange() {
    if (!employeeId) return
    const today = toISO(new Date(year, 0, 1))
    setModal({ employeeId, start: today, end: today, type: 'vacation' })
  }

  return (
    <section>
      <header className="section-head">
        <h1>Calendario anual</h1>
        <div className="actions">
          <input
            type="number"
            min={2024}
            max={2030}
            value={year}
            onChange={(e) => setYear(+e.target.value)}
          />
          <div className="toggle">
            <button
              className={view === 'single' ? 'active' : ''}
              onClick={() => setView('single')}
            >
              Por empleado
            </button>
            <button
              className={view === 'all' ? 'active' : ''}
              onClick={() => setView('all')}
            >
              Ver todos
            </button>
          </div>
          {view === 'single' && employeeId && <button onClick={onAddRange}>+ Nueva solicitud</button>}
        </div>
      </header>

      {view === 'single' && (
        <div className="employee-picker">
          {employees.map((e) => (
            <button
              key={e.id}
              onClick={() => setEmployeeId(e.id)}
              className={`pick ${e.id === employeeId ? 'active' : ''}`}
            >
              {e.full_name}
            </button>
          ))}
        </div>
      )}

      <p className="muted small">
        {view === 'single'
          ? 'Tocá un día para abrir el editor (un rango de 1 día por defecto). Para cargar varios días seguidos, ajustá la fecha "Hasta" en el modal.'
          : 'Vista global de todos los empleados. Tocá una celda para editar la solicitud del empleado correspondiente.'}
      </p>

      <div className="legend">
        <span className="legend-chip cell-vacation">V</span> Vacaciones
        <span className="legend-chip cell-personal">P</span> Personal
        <span className="legend-chip cell-holiday">F</span> Festivo
      </div>

      {view === 'single' && employeeId && (
        <div className="year-grid">
          {Array.from({ length: 12 }, (_, m) => (
            <MiniCalendar
              key={m}
              year={year}
              month={m}
              dayMap={dayMap}
              onCellClick={onCellClick}
            />
          ))}
        </div>
      )}

      {view === 'all' && (
        <div className="global-year">
          {Array.from({ length: 12 }, (_, m) => (
            <GlobalMonth
              key={m}
              year={year}
              month={m}
              employees={employees}
              requests={requests}
              onCellClick={onCellClickForEmployee}
            />
          ))}
        </div>
      )}

      {modal && (
        <div className="modal-backdrop" onClick={() => !busy && setModal(null)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <h2>{modal.existingId ? 'Editar solicitud' : 'Nueva solicitud'}</h2>
            <label>
              Tipo
              <select
                value={modal.type}
                onChange={(e) => setModal({ ...modal, type: e.target.value as RequestType })}
              >
                <option value="vacation">Vacaciones</option>
                <option value="personal">Personal</option>
                <option value="holiday">Festivo</option>
              </select>
            </label>
            <label>
              Desde
              <input
                type="date"
                value={modal.start}
                onChange={(e) => setModal({ ...modal, start: e.target.value })}
              />
            </label>
            <label>
              Hasta
              <input
                type="date"
                value={modal.end}
                onChange={(e) => setModal({ ...modal, end: e.target.value })}
              />
            </label>
            <div className="actions">
              {modal.existingId && (
                <button className="link danger" onClick={onDelete} disabled={busy}>
                  Borrar
                </button>
              )}
              <button className="link" onClick={() => setModal(null)} disabled={busy}>
                Cancelar
              </button>
              <button onClick={onSave} disabled={busy}>
                {busy ? 'Guardando...' : 'Guardar'}
              </button>
            </div>
          </div>
        </div>
      )}
    </section>
  )
}

function GlobalMonth({
  year,
  month,
  employees,
  requests,
  onCellClick,
}: {
  year: number
  month: number
  employees: Employee[]
  requests: DayRequest[]
  onCellClick: (empId: string, dateISO: string) => void
}) {
  const days = eachDayInMonth(new Date(year, month, 1))
  const byEmpDay = useMemo(() => {
    const m = new Map<string, RequestType>()
    for (const r of requests) {
      if (r.status !== 'approved') continue
      let cur = fromISO(r.start_date)
      const end = fromISO(r.end_date)
      while (cur <= end) {
        m.set(`${r.employee_id}|${toISO(cur)}`, r.type)
        cur = addDays(cur, 1)
      }
    }
    return m
  }, [requests])

  return (
    <div className="global-month">
      <h3>{format(new Date(year, month, 1), 'MMMM yyyy')}</h3>
      <div className="global-table-wrap">
        <table className="global-table">
          <thead>
            <tr>
              <th className="sticky-col">Empleado</th>
              {days.map((d) => {
                const wk = d.getDay() === 0 || d.getDay() === 6
                return (
                  <th key={toISO(d)} className={wk ? 'weekend' : ''}>
                    <div>{d.getDate()}</div>
                    <div className="dow">{['D', 'L', 'M', 'X', 'J', 'V', 'S'][d.getDay()]}</div>
                  </th>
                )
              })}
            </tr>
          </thead>
          <tbody>
            {employees.map((e) => (
              <tr key={e.id}>
                <td className="sticky-col">{e.full_name}</td>
                {days.map((d) => {
                  const dISO = toISO(d)
                  const t = byEmpDay.get(`${e.id}|${dISO}`)
                  const cls = t ? `cell cell-${t}` : 'cell'
                  const label = t === 'vacation' ? 'V' : t === 'personal' ? 'P' : t === 'holiday' ? 'F' : ''
                  return (
                    <td key={dISO} className={cls} onClick={() => onCellClick(e.id, dISO)}>
                      {label}
                    </td>
                  )
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}

function MiniCalendar({
  year,
  month,
  dayMap,
  onCellClick,
}: {
  year: number
  month: number
  dayMap: Map<string, { type: RequestType; start: string; end: string }>
  onCellClick: (dateISO: string) => void
}) {
  const days = eachDayInMonth(new Date(year, month, 1))
  const offset = (days[0].getDay() + 6) % 7
  const cells: (Date | null)[] = Array(offset).fill(null).concat(days)
  while (cells.length % 7 !== 0) cells.push(null)
  const weeks: (Date | null)[][] = []
  for (let i = 0; i < cells.length; i += 7) weeks.push(cells.slice(i, i + 7))

  return (
    <div className="mini-cal">
      <h3>{format(new Date(year, month, 1), 'MMMM yyyy')}</h3>
      <table>
        <thead>
          <tr>
            {['L', 'M', 'X', 'J', 'V', 'S', 'D'].map((d) => (
              <th key={d}>{d}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {weeks.map((week, i) => (
            <tr key={i}>
              {week.map((d, j) => {
                if (!d) return <td key={j}></td>
                const dISO = toISO(d)
                const cell = dayMap.get(dISO)
                const cls = cell ? `cell cell-${cell.type}` : 'cell'
                const label = cell
                  ? cell.type === 'vacation'
                    ? 'V'
                    : cell.type === 'personal'
                      ? 'P'
                      : 'F'
                  : d.getDate()
                return (
                  <td key={j} className={cls} onClick={() => onCellClick(dISO)} title={dISO}>
                    {label}
                  </td>
                )
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}
