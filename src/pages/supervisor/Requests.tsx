import { useEffect, useMemo, useState } from 'react'
import { db } from '../../lib/db'
import { useSession } from '../../hooks/useSession'
import { daysBetween, monthKey, nextMonth } from '../../lib/dates'
import type { Category, DayRequest, Department, Employee, RequestType } from '../../types/database'

export default function Requests() {
  const session = useSession()
  const [requests, setRequests] = useState<DayRequest[]>([])
  const [employees, setEmployees] = useState<Employee[]>([])
  const [departments, setDepartments] = useState<Department[]>([])
  const [categories, setCategories] = useState<Category[]>([])
  const [scope, setScope] = useState<string>('')
  const [targetMonth, setTargetMonth] = useState<string>(monthKey(nextMonth(new Date())))

  async function reload() {
    const [r, e, ds, cs] = await Promise.all([
      db.dayRequests.list(),
      db.employees.list(),
      db.departments.list(),
      db.categories.list(),
    ])
    r.sort((a, b) => a.start_date.localeCompare(b.start_date))
    setRequests(r)
    setEmployees(e)
    setDepartments(ds)
    setCategories(cs)
    if (!scope && ds.length > 0) setScope(`dept:${ds[0].id}`)
  }

  useEffect(() => {
    reload()
  }, [])

  const filtered = useMemo(() => {
    if (!scope) return requests.filter((r) => r.target_month === targetMonth)
    const [kind, id] = scope.split(':')
    let catIds: Set<string>
    if (kind === 'cat') {
      catIds = new Set([id])
    } else {
      catIds = new Set(categories.filter((c) => c.department_id === id).map((c) => c.id))
    }
    const empIds = new Set(employees.filter((e) => e.category_id && catIds.has(e.category_id)).map((e) => e.id))
    return requests.filter((r) => r.target_month === targetMonth && empIds.has(r.employee_id))
  }, [requests, targetMonth, employees, categories, scope])

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
          <input
            type="month"
            value={targetMonth.slice(0, 7)}
            onChange={(e) => {
              if (!e.target.value) return
              setTargetMonth(`${e.target.value}-01`)
            }}
          />
        </div>
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
