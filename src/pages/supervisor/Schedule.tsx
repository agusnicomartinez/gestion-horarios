import { useEffect, useMemo, useState } from 'react'
import { db } from '../../lib/db'
import {
  carryOverFromEntries,
  generateSchedule,
  type Violation,
} from '../../lib/schedule'
import { eachDayInMonth, fromISO, monthKey, nextMonth, toISO } from '../../lib/dates'
import type {
  DayRequest,
  Employee,
  PublicHoliday,
  Schedule,
  ScheduleEntry,
  Shift,
} from '../../types/database'
import { format } from 'date-fns'

function shiftTitle(s: Shift): string {
  switch (s) {
    case 'morning': return 'Mañana'
    case 'afternoon': return 'Tarde'
    case 'vacation': return 'Vacaciones'
    case 'holiday': return 'Festivo'
    case 'personal': return 'Personal'
    default: return 'Libre'
  }
}

export default function SupervisorSchedule() {
  const [targetMonth, setTargetMonth] = useState<string>(monthKey(nextMonth(new Date())))
  const [employees, setEmployees] = useState<Employee[]>([])
  const [schedule, setSchedule] = useState<Schedule | null>(null)
  const [entries, setEntries] = useState<ScheduleEntry[]>([])
  const [violations, setViolations] = useState<Violation[]>([])
  const [requests, setRequests] = useState<DayRequest[]>([])
  const [holidays, setHolidays] = useState<PublicHoliday[]>([])
  const [busy, setBusy] = useState(false)

  async function reload() {
    const [emps, schedulesAll, requestsAll, holidaysAll] = await Promise.all([
      db.employees.list(),
      db.schedules.list(),
      db.dayRequests.list(),
      db.publicHolidays.list(),
    ])
    const active = emps.filter((e) => e.active)
    setEmployees(active)
    setRequests(requestsAll)
    setHolidays(holidaysAll)
    const sch = schedulesAll.find((s) => s.month === targetMonth) ?? null
    setSchedule(sch)
    if (sch) {
      const allEntries = await db.scheduleEntries.list()
      setEntries(allEntries.filter((e) => e.schedule_id === sch.id))
    } else {
      setEntries([])
    }
  }

  useEffect(() => {
    reload()
  }, [targetMonth])

  async function onGenerate() {
    setBusy(true)
    setViolations([])
    try {
      let sch = schedule
      let manualEntries: ScheduleEntry[] = []
      if (!sch) {
        sch = await db.schedules.insert({
          month: targetMonth,
          status: 'draft',
          created_at: new Date().toISOString(),
        })
      } else {
        // Preserve cells the supervisor manually edited (or coming from
        // approved requests). Regeneration only wipes the auto-generated rows.
        const existing = (await db.scheduleEntries.list()).filter(
          (e) => e.schedule_id === sch!.id,
        )
        manualEntries = existing.filter((e) => e.source !== 'auto')
        await db.scheduleEntries.removeWhere((e) => e.schedule_id === sch!.id)
        sch = await db.schedules.update(sch.id, { status: 'draft', published_at: null })
      }

      const prevMonthDate = new Date(fromISO(targetMonth))
      prevMonthDate.setMonth(prevMonthDate.getMonth() - 1)
      const prevMonthISO = monthKey(prevMonthDate)
      const allEntries = await db.scheduleEntries.list()
      const prevSchedules = (await db.schedules.list()).filter((s) => s.month === prevMonthISO)
      const prevEntries = allEntries.filter((e) =>
        prevSchedules.some((s) => s.id === e.schedule_id),
      )

      const settings = await db.settings.get()
      const result = generateSchedule({
        monthISO: targetMonth,
        employees,
        approvedRequests: requests.filter(
          (r) => r.target_month === targetMonth && r.status === 'approved',
        ),
        holidays,
        carryOver: carryOverFromEntries(prevEntries, targetMonth),
        restDaysPerYear: settings.rest_days_per_year,
      })

      // Overwrite auto picks with the preserved manual cells (if any).
      const manualMap = new Map<string, ScheduleEntry>()
      for (const m of manualEntries) {
        manualMap.set(`${m.employee_id}|${m.date}`, m)
      }
      const finalEntries = result.entries.map((e) => {
        const m = manualMap.get(`${e.employee_id}|${e.date}`)
        if (m) return { ...e, shift: m.shift, source: m.source }
        return e
      })

      await db.scheduleEntries.insertMany(
        finalEntries.map((e) => ({ ...e, schedule_id: sch!.id })),
      )
      setViolations(result.violations)
      await reload()
    } catch (err) {
      console.error('Generate failed:', err)
      alert(`Error al generar el cronograma: ${err instanceof Error ? err.message : String(err)}`)
    } finally {
      setBusy(false)
    }
  }

  async function onPublish() {
    if (!schedule) return
    if (!confirm('Publicar este cronograma?')) return
    await db.schedules.update(schedule.id, {
      status: 'published',
      published_at: new Date().toISOString(),
    })
    reload()
  }

  async function onUnpublish() {
    if (!schedule) return
    await db.schedules.update(schedule.id, { status: 'draft', published_at: null })
    reload()
  }

  async function onCellChange(employeeId: string, date: string, shift: Shift) {
    if (!schedule) return
    const existing = entries.find((e) => e.employee_id === employeeId && e.date === date)
    if (existing) {
      await db.scheduleEntries.update(existing.id, { shift, source: 'manual' })
    } else {
      await db.scheduleEntries.insert({
        schedule_id: schedule.id,
        employee_id: employeeId,
        date,
        shift,
        source: 'manual',
      })
    }
    reload()
  }

  const days = useMemo(() => eachDayInMonth(fromISO(targetMonth)), [targetMonth])
  const entryMap = useMemo(() => {
    const m = new Map<string, ScheduleEntry>()
    entries.forEach((e) => m.set(`${e.employee_id}|${e.date}`, e))
    return m
  }, [entries])
  const holidayDates = useMemo(() => new Set(holidays.map((h) => h.date)), [holidays])

  return (
    <section>
      <header className="section-head">
        <h1>Cronograma</h1>
        <input
          type="month"
          value={targetMonth.slice(0, 7)}
          onChange={(e) => setTargetMonth(`${e.target.value}-01`)}
        />
      </header>

      <div className="actions sticky">
        <button onClick={onGenerate} disabled={busy || employees.length === 0}>
          {busy ? 'Generando...' : schedule ? 'Regenerar' : 'Generar propuesta'}
        </button>
        {schedule && schedule.status === 'draft' && (
          <button onClick={onPublish}>Publicar</button>
        )}
        {schedule && schedule.status === 'published' && (
          <button className="link" onClick={onUnpublish}>Despublicar</button>
        )}
        {schedule && (
          <span className={`badge status-${schedule.status}`}>
            {schedule.status === 'published' ? 'Publicado' : 'Borrador'}
          </span>
        )}
      </div>

      {employees.length === 0 && (
        <p className="muted">Cargá empleados activos antes de generar el cronograma.</p>
      )}

      {schedule && (
        <>
          {violations.length > 0 && (
            <div className="card violations">
              <h3>Avisos ({violations.length})</h3>
              <ul>
                {violations.map((v, i) => (
                  <li key={i}>{v.detail}</li>
                ))}
              </ul>
            </div>
          )}
          <div className="grid-scroll">
            <table className="grid">
              <thead>
                <tr>
                  <th className="sticky-col">Empleado</th>
                  {days.map((d) => (
                    <th
                      key={toISO(d)}
                      className={
                        (holidayDates.has(toISO(d)) ? 'holiday ' : '') +
                        (d.getDay() === 0 || d.getDay() === 6 ? 'weekend' : '')
                      }
                    >
                      <div>{format(d, 'd')}</div>
                      <div className="dow">{['D','L','M','X','J','V','S'][d.getDay()]}</div>
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {employees.map((e) => (
                  <tr key={e.id}>
                    <td className="sticky-col">{e.full_name}</td>
                    {days.map((d) => {
                      const dISO = toISO(d)
                      const entry = entryMap.get(`${e.id}|${dISO}`)
                      const shift: Shift = entry?.shift ?? 'off'
                      return (
                        <td key={dISO} className={`shift-cell shift-${shift}`}>
                          <select
                            value={shift}
                            onChange={(ev) => onCellChange(e.id, dISO, ev.target.value as Shift)}
                            title={shiftTitle(shift)}
                          >
                            <option value="off">L</option>
                            <option value="morning">M</option>
                            <option value="afternoon">T</option>
                            <option value="vacation">V</option>
                            <option value="holiday">F</option>
                            <option value="personal">P</option>
                          </select>
                        </td>
                      )
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </section>
  )
}
