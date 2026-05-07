import { useEffect, useMemo, useState } from 'react'
import { db } from '../../lib/db'
import { useSession } from '../../hooks/useSession'
import { daysBetween, monthKey, nextMonth } from '../../lib/dates'
import type { DayRequest, Employee, RequestType } from '../../types/database'

export default function Requests() {
  const session = useSession()
  const [requests, setRequests] = useState<DayRequest[]>([])
  const [employees, setEmployees] = useState<Employee[]>([])
  const [targetMonth, setTargetMonth] = useState<string>(monthKey(nextMonth(new Date())))

  async function reload() {
    const [r, e] = await Promise.all([db.dayRequests.list(), db.employees.list()])
    r.sort((a, b) => a.start_date.localeCompare(b.start_date))
    setRequests(r)
    setEmployees(e)
  }

  useEffect(() => {
    reload()
  }, [])

  const filtered = useMemo(
    () => requests.filter((r) => r.target_month === targetMonth),
    [requests, targetMonth],
  )

  const employeeMap = useMemo(() => {
    const m = new Map<string, Employee>()
    employees.forEach((e) => m.set(e.id, e))
    return m
  }, [employees])

  async function decide(req: DayRequest, status: 'approved' | 'rejected') {
    await db.dayRequests.update(req.id, {
      status,
      reviewed_at: new Date().toISOString(),
      reviewed_by: session?.userId ?? null,
    })
    reload()
  }

  return (
    <section>
      <header className="section-head">
        <h1>Solicitudes</h1>
        <input
          type="month"
          value={targetMonth.slice(0, 7)}
          onChange={(e) => setTargetMonth(`${e.target.value}-01`)}
        />
      </header>

      <ul className="list">
        {filtered.length === 0 && <li className="muted">Sin solicitudes para este mes.</li>}
        {filtered.map((r) => {
          const emp = employeeMap.get(r.employee_id)
          return (
            <li key={r.id} className={`row request status-${r.status}`}>
              <div>
                <strong>{emp?.full_name ?? '—'}</strong>
                <div className="muted small">
                  {labelType(r.type)} · {r.start_date} → {r.end_date} ({daysBetween(r.start_date, r.end_date)} días)
                </div>
                <div className="muted small">Estado: {labelStatus(r.status)}</div>
              </div>
              <div className="actions">
                {r.status !== 'approved' && (
                  <button onClick={() => decide(r, 'approved')}>Aprobar</button>
                )}
                {r.status !== 'rejected' && (
                  <button className="link danger" onClick={() => decide(r, 'rejected')}>Rechazar</button>
                )}
              </div>
            </li>
          )
        })}
      </ul>
    </section>
  )
}

function labelType(t: RequestType): string {
  switch (t) {
    case 'vacation': return 'Vacaciones'
    case 'personal': return 'Personal'
    case 'holiday': return 'Festivo'
    case 'sick': return 'Baja médica'
  }
}

function labelStatus(s: string): string {
  return s === 'pending' ? 'Pendiente' : s === 'approved' ? 'Aprobada' : 'Rechazada'
}
