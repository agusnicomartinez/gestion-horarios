import { useEffect, useMemo, useState } from 'react'
import { db } from '../../lib/db'
import { useSession } from '../../hooks/useSession'
import {
  addDays,
  eachDayInMonth,
  endOfWeek,
  isSameDay,
  startOfWeek,
  toISO,
} from '../../lib/dates'
import type { ScheduleEntry, Schedule, Shift } from '../../types/database'
import { format } from 'date-fns'

type ViewMode = 'week' | 'month'

export default function MySchedule() {
  const session = useSession()
  const [view, setView] = useState<ViewMode>('week')
  const [anchor, setAnchor] = useState<Date>(new Date())
  const [entries, setEntries] = useState<ScheduleEntry[]>([])
  const [holidays, setHolidays] = useState<Set<string>>(new Set())
  const [loading, setLoading] = useState(true)

  async function reload() {
    if (!session) return
    setLoading(true)
    const [schedules, allEntries, hol] = await Promise.all([
      db.schedules.list(),
      db.scheduleEntries.list(),
      db.publicHolidays.list(),
    ])
    const published = new Set(
      schedules.filter((s: Schedule) => s.status === 'published').map((s) => s.id),
    )
    setEntries(
      allEntries.filter(
        (e) => published.has(e.schedule_id) && e.employee_id === session.userId,
      ),
    )
    setHolidays(new Set(hol.map((h) => h.date)))
    setLoading(false)
  }

  useEffect(() => {
    reload()
  }, [session?.userId])

  const entryByDate = useMemo(() => {
    const m = new Map<string, ScheduleEntry>()
    entries.forEach((e) => m.set(e.date, e))
    return m
  }, [entries])

  if (!session) return null

  const days = useMemo(() => {
    if (view === 'week') {
      const start = startOfWeek(anchor, { weekStartsOn: 1 })
      const end = endOfWeek(anchor, { weekStartsOn: 1 })
      const out: Date[] = []
      for (let cur = start; cur <= end; cur = addDays(cur, 1)) out.push(new Date(cur))
      return out
    }
    return eachDayInMonth(anchor)
  }, [view, anchor])

  function move(direction: -1 | 1) {
    if (view === 'week') {
      setAnchor((a) => addDays(a, direction * 7))
    } else {
      const next = new Date(anchor)
      next.setMonth(next.getMonth() + direction)
      setAnchor(next)
    }
  }

  return (
    <section>
      <header className="section-head">
        <h1>Mi horario</h1>
        <div className="toggle">
          <button
            className={view === 'week' ? 'active' : ''}
            onClick={() => setView('week')}
          >Semana</button>
          <button
            className={view === 'month' ? 'active' : ''}
            onClick={() => setView('month')}
          >Mes</button>
        </div>
      </header>

      <div className="actions">
        <button className="link" onClick={() => move(-1)}>← Anterior</button>
        <strong>
          {view === 'week'
            ? `Semana del ${format(days[0], 'd MMM')}`
            : format(anchor, 'MMMM yyyy')}
        </strong>
        <button className="link" onClick={() => move(1)}>Siguiente →</button>
      </div>

      {loading && <p className="muted">Cargando...</p>}

      {view === 'week' && (
        <ul className="week-list">
          {days.map((d) => {
            const e = entryByDate.get(toISO(d))
            const shift: Shift = e?.shift ?? 'off'
            const today = isSameDay(d, new Date())
            return (
              <li key={toISO(d)} className={`week-row shift-${shift} ${today ? 'today' : ''}`}>
                <div className="week-date">
                  <div className="dow-long">{format(d, 'EEE')}</div>
                  <div className="day-num">{format(d, 'd')}</div>
                </div>
                <div className="week-shift">
                  <strong>{labelShift(shift)}</strong>
                  {shift === 'morning' && <div className="muted small">7:00 – 15:00</div>}
                  {shift === 'afternoon' && <div className="muted small">15:00 – 23:00</div>}
                  {holidays.has(toISO(d)) && <div className="badge holiday">Festivo</div>}
                </div>
              </li>
            )
          })}
        </ul>
      )}

      {view === 'month' && (
        <table className="grid month-view">
          <thead>
            <tr>
              {['L','M','X','J','V','S','D'].map((d) => <th key={d}>{d}</th>)}
            </tr>
          </thead>
          <tbody>
            {chunkMonth(days).map((week, i) => (
              <tr key={i}>
                {week.map((d, j) => d ? (
                  <td
                    key={j}
                    className={`shift-cell shift-${entryByDate.get(toISO(d))?.shift ?? 'off'} ${
                      isSameDay(d, new Date()) ? 'today' : ''
                    } ${holidays.has(toISO(d)) ? 'holiday' : ''}`}
                  >
                    <div className="day-num">{format(d, 'd')}</div>
                    <div className="cell-shift">{shortShift(entryByDate.get(toISO(d))?.shift ?? 'off')}</div>
                  </td>
                ) : <td key={j}></td>)}
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  )
}

function labelShift(s: Shift): string {
  switch (s) {
    case 'morning': return 'Mañana'
    case 'afternoon': return 'Tarde'
    case 'vacation': return 'Vacaciones'
    case 'holiday': return 'Festivo'
    case 'personal': return 'Personal'
    default: return 'Libre'
  }
}
function shortShift(s: Shift): string {
  switch (s) {
    case 'morning': return 'M'
    case 'afternoon': return 'T'
    case 'vacation': return 'V'
    case 'holiday': return 'F'
    case 'personal': return 'P'
    default: return 'L'
  }
}

function chunkMonth(days: Date[]): (Date | null)[][] {
  const first = days[0]
  // Monday-first: getDay() returns 0 (Sun) – 6 (Sat). We want Mon=0..Sun=6.
  const offset = (first.getDay() + 6) % 7
  const padded: (Date | null)[] = Array(offset).fill(null).concat(days)
  while (padded.length % 7 !== 0) padded.push(null)
  const weeks: (Date | null)[][] = []
  for (let i = 0; i < padded.length; i += 7) weeks.push(padded.slice(i, i + 7))
  return weeks
}
