import { useEffect, useMemo, useState, type FormEvent } from 'react'
import { db } from '../../lib/db'
import { useSession } from '../../hooks/useSession'
import { daysBetween, requestWindow } from '../../lib/dates'
import { consumedFromRequests, consumedRestDays, remainingBalance } from '../../lib/balance'
import type { DayRequest, GlobalSettings, RequestType, ScheduleEntry } from '../../types/database'
import { format } from 'date-fns'

export default function EmployeeRequest() {
  const session = useSession()
  const [requests, setRequests] = useState<DayRequest[]>([])
  const [settings, setSettings] = useState<GlobalSettings | null>(null)
  const [entries, setEntries] = useState<ScheduleEntry[]>([])
  const [type, setType] = useState<RequestType>('vacation')
  const [start, setStart] = useState('')
  const [end, setEnd] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const win = useMemo(() => requestWindow(), [])

  async function reload() {
    if (!session) return
    const all = await db.dayRequests.list()
    const mine = all
      .filter((r) => r.employee_id === session.userId)
      .sort((a, b) => b.start_date.localeCompare(a.start_date))
    setRequests(mine)
    setSettings(await db.settings.get())
    const allEntries = await db.scheduleEntries.list()
    setEntries(allEntries.filter((e) => e.employee_id === session.userId))
  }

  useEffect(() => {
    reload()
  }, [session?.userId])

  if (!session || !settings) return null

  const year = new Date().getFullYear()
  const consumedReq = consumedFromRequests(requests, session.userId, year)
  const restConsumed = consumedRestDays(entries, requests, session.userId, year)
  const remaining = remainingBalance(settings, { ...consumedReq, rest: restConsumed })

  async function onSubmit(e: FormEvent) {
    e.preventDefault()
    setError(null)
    if (!start || !end) {
      setError('Fechas obligatorias')
      return
    }
    if (end < start) {
      setError('La fecha final no puede ser anterior a la inicial')
      return
    }
    const days = daysBetween(start, end)
    if (type === 'vacation' && days < 7) {
      setError('Las vacaciones requieren un mínimo de 7 días corridos')
      return
    }
    if (type === 'vacation' && days > remaining.vacation) {
      setError(`Solo te quedan ${remaining.vacation} días de vacaciones`)
      return
    }
    if (type === 'personal' && days > remaining.personal) {
      setError(`Solo te quedan ${remaining.personal} días personales`)
      return
    }
    if (type === 'holiday' && days > remaining.holiday) {
      setError(`Solo te quedan ${remaining.holiday} días festivos`)
      return
    }
    setBusy(true)
    try {
      await db.dayRequests.insert({
        employee_id: session!.userId,
        type,
        start_date: start,
        end_date: end,
        status: 'pending',
        target_month: win.targetMonth,
      })
      setStart(''); setEnd(''); setType('vacation')
      reload()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Error al enviar')
    } finally {
      setBusy(false)
    }
  }

  async function onCancel(req: DayRequest) {
    if (req.status !== 'pending') return
    if (!confirm('Cancelar esta solicitud?')) return
    await db.dayRequests.remove(req.id)
    reload()
  }

  return (
    <section>
      <h1>Solicitudes</h1>

      <div className="card balances">
        <div className="balance">
          <span className="muted">Vacaciones</span>
          <strong>{remaining.vacation} / {settings.vacation_days_per_year}</strong>
        </div>
        <div className="balance">
          <span className="muted">Personales</span>
          <strong>{remaining.personal} / {settings.personal_days_per_year}</strong>
        </div>
        <div className="balance">
          <span className="muted">Festivos</span>
          <strong>{remaining.holiday} / {settings.holiday_days_per_year}</strong>
        </div>
        <div className="balance">
          <span className="muted">Días libres</span>
          <strong>{remaining.rest} / {settings.rest_days_per_year}</strong>
        </div>
      </div>

      <div className="card">
        <h2>Nueva solicitud</h2>
        {!win.open ? (
          <p className="muted">
            Ventana cerrada. Se abre el día 1 a las 00:00 y se cierra el 11 a las 00:00 (último día válido es el 10). Mes objetivo: {win.targetMonth.slice(0, 7)}.
          </p>
        ) : (
          <form className="form" onSubmit={onSubmit}>
            <p className="muted small">Mes objetivo: {win.targetMonth.slice(0, 7)}</p>
            <label>
              Tipo
              <select value={type} onChange={(e) => setType(e.target.value as RequestType)}>
                <option value="vacation">Vacaciones (mín 7 días corridos)</option>
                <option value="personal">Personal (días sueltos)</option>
                <option value="holiday">Festivo</option>
              </select>
            </label>
            <label>
              Desde
              <input type="date" value={start} onChange={(e) => setStart(e.target.value)} required />
            </label>
            <label>
              Hasta
              <input type="date" value={end} onChange={(e) => setEnd(e.target.value)} required />
            </label>
            {error && <p className="error">{error}</p>}
            <button type="submit" disabled={busy}>{busy ? 'Enviando...' : 'Enviar solicitud'}</button>
          </form>
        )}
      </div>

      <h2>Mis solicitudes</h2>
      <ul className="list">
        {requests.length === 0 && <li className="muted">Sin solicitudes.</li>}
        {requests.map((r) => (
          <li key={r.id} className={`row request status-${r.status}`}>
            <div>
              <strong>{labelType(r.type)}</strong>
              <div className="muted small">
                {r.start_date} → {r.end_date} ({daysBetween(r.start_date, r.end_date)} días)
              </div>
              <div className="muted small">
                Mes {r.target_month.slice(0, 7)} · {labelStatus(r.status)}
                {r.created_at && ` · enviada ${format(new Date(r.created_at), 'd MMM')}`}
              </div>
            </div>
            {r.status === 'pending' && (
              <button className="link danger" onClick={() => onCancel(r)}>Cancelar</button>
            )}
          </li>
        ))}
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
