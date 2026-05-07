import { useEffect, useMemo, useState } from 'react'
import { db } from '../../lib/db'
import type { DayRequest, Employee, RequestType } from '../../types/database'
import { eachDayInMonth, fromISO, toISO } from '../../lib/dates'
import { addDays, format } from 'date-fns'

type CellType = RequestType | null
const CYCLE: CellType[] = [null, 'vacation', 'personal', 'holiday']

export default function Calendar() {
  const [employees, setEmployees] = useState<Employee[]>([])
  const [employeeId, setEmployeeId] = useState<string | null>(null)
  const [year, setYear] = useState(new Date().getFullYear())
  const [requests, setRequests] = useState<DayRequest[]>([])
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

  async function onCellClick(dateISO: string) {
    if (!employeeId || busy) return
    const existing = dayMap.get(dateISO)
    setBusy(true)
    try {
      if (existing) {
        const req = requests.find((r) => r.id === existing.reqId)
        if (!req) return
        if (req.start_date !== req.end_date) {
          alert('Esta fecha es parte de un rango. Editá la solicitud completa desde el panel de Solicitudes.')
          return
        }
        const idx = CYCLE.indexOf(existing.type)
        const next = CYCLE[(idx + 1) % CYCLE.length]
        if (next === null) {
          await db.dayRequests.remove(req.id)
        } else {
          await db.dayRequests.update(req.id, { type: next })
        }
      } else {
        await db.dayRequests.insert({
          employee_id: employeeId,
          type: 'vacation',
          start_date: dateISO,
          end_date: dateISO,
          status: 'approved',
          target_month: dateISO.slice(0, 7) + '-01',
        })
      }
      await reload()
    } finally {
      setBusy(false)
    }
  }

  return (
    <section>
      <header className="section-head">
        <h1>Calendario anual</h1>
        <input
          type="number"
          min={2024}
          max={2030}
          value={year}
          onChange={(e) => setYear(+e.target.value)}
        />
      </header>

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

      <p className="muted small">
        Click en un día para alternar Vacaciones → Personal → Festivo → vacío.
        Las marcas se guardan como solicitudes aprobadas y el algoritmo las
        respeta cuando generás el cronograma.
      </p>

      <div className="legend">
        <span className="legend-chip cell-vacation">V</span> Vacaciones
        <span className="legend-chip cell-personal">P</span> Personal
        <span className="legend-chip cell-holiday">F</span> Festivo
      </div>

      {employeeId && (
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
    </section>
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
