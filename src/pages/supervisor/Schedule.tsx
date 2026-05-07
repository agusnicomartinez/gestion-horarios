import { useEffect, useMemo, useState } from 'react'
import { db } from '../../lib/db'
import {
  carryOverFromEntries,
  generateSchedule,
  type Violation,
} from '../../lib/schedule'
import { eachDayInMonth, fromISO, monthKey, nextMonth, toISO } from '../../lib/dates'
import type {
  Category,
  DayRequest,
  Department,
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
    case 'night': return 'Noche'
    case 'partido': return 'Partido'
    case 'vacation': return 'Vacaciones'
    case 'holiday': return 'Festivo'
    case 'personal': return 'Día personal'
    case 'sick': return 'Baja médica'
    default: return 'Libre'
  }
}

function shiftAllowedFor(
  emp: Employee,
  shift: 'morning' | 'afternoon' | 'night' | 'partido',
): boolean {
  if (emp.shift_type === 'all') return true
  if (emp.shift_type === 'both') return shift === 'morning' || shift === 'afternoon'
  return emp.shift_type === shift
}

export default function SupervisorSchedule() {
  const [targetMonth, setTargetMonth] = useState<string>(monthKey(nextMonth(new Date())))
  const [departments, setDepartments] = useState<Department[]>([])
  const [categories, setCategories] = useState<Category[]>([])
  const [departmentId, setDepartmentId] = useState<string>('')
  const [employees, setEmployees] = useState<Employee[]>([])
  const [schedule, setSchedule] = useState<Schedule | null>(null)
  const [entries, setEntries] = useState<ScheduleEntry[]>([])
  const [violations, setViolations] = useState<Violation[]>([])
  const [requests, setRequests] = useState<DayRequest[]>([])
  const [holidays, setHolidays] = useState<PublicHoliday[]>([])
  const [busy, setBusy] = useState(false)

  async function reload() {
    const [emps, schedulesAll, requestsAll, holidaysAll, deptsAll, catsAll] =
      await Promise.all([
        db.employees.list(),
        db.schedules.list(),
        db.dayRequests.list(),
        db.publicHolidays.list(),
        db.departments.list(),
        db.categories.list(),
      ])
    setDepartments(deptsAll)
    setCategories(catsAll)
    const dept = departmentId || deptsAll[0]?.id || ''
    if (!departmentId && dept) setDepartmentId(dept)
    const catIdsInDept = catsAll.filter((c) => c.department_id === dept).map((c) => c.id)
    const active = emps.filter((e) => e.active && e.category_id && catIdsInDept.includes(e.category_id))
    setEmployees(active)
    setRequests(requestsAll)
    setHolidays(holidaysAll)
    const sch =
      schedulesAll.find((s) => s.month === targetMonth && s.department_id === dept) ?? null
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
  }, [targetMonth, departmentId])

  async function onGenerate() {
    setBusy(true)
    setViolations([])
    try {
      let sch = schedule
      let manualEntries: ScheduleEntry[] = []
      if (!sch) {
        sch = await db.schedules.insert({
          month: targetMonth,
          department_id: departmentId || null,
          status: 'draft',
          created_at: new Date().toISOString(),
        })
      } else {
        // Preserve cells the supervisor manually edited. Request-sourced
        // entries are regenerated from the current approval state so that
        // toggling a request to rejected (or approving a new one) is
        // reflected on the next regenerate.
        const existing = (await db.scheduleEntries.list()).filter(
          (e) => e.schedule_id === sch!.id,
        )
        manualEntries = existing.filter((e) => e.source === 'manual')
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
      // Match any approved request whose date range overlaps the schedule
      // month, restricted to the current department's employees.
      const monthStart = targetMonth
      const monthEnd = toISO(new Date(fromISO(targetMonth).getFullYear(), fromISO(targetMonth).getMonth() + 1, 0))
      const empIds = new Set(employees.map((e) => e.id))
      const allApproved = requests.filter(
        (r) =>
          empIds.has(r.employee_id) &&
          r.status === 'approved' &&
          r.start_date <= monthEnd &&
          r.end_date >= monthStart,
      )

      // Run the generator once per category so each one uses its own
      // coverage config (M/T/N/P). Merge the resulting entries.
      const catsInDept = categories.filter((c) => c.department_id === departmentId)
      const generatedEntries: Omit<ScheduleEntry, 'id' | 'schedule_id'>[] = []
      const allViolations: Violation[] = []
      for (const cat of catsInDept) {
        const catEmployees = employees.filter((e) => e.category_id === cat.id)
        if (catEmployees.length === 0) continue
        const catEmpIds = new Set(catEmployees.map((e) => e.id))
        const catApproved = allApproved.filter((r) => catEmpIds.has(r.employee_id))
        const result = generateSchedule({
          monthISO: targetMonth,
          employees: catEmployees,
          approvedRequests: catApproved,
          holidays,
          carryOver: carryOverFromEntries(prevEntries, targetMonth),
          restDaysPerYear: settings.rest_days_per_year,
          coverage: cat.coverage,
        })
        generatedEntries.push(...result.entries)
        allViolations.push(...result.violations)
      }

      // Overwrite auto picks with the preserved manual cells (if any).
      const manualMap = new Map<string, ScheduleEntry>()
      for (const m of manualEntries) {
        manualMap.set(`${m.employee_id}|${m.date}`, m)
      }
      const finalEntries = generatedEntries.map((e) => {
        const m = manualMap.get(`${e.employee_id}|${e.date}`)
        if (m) return { ...e, shift: m.shift, source: m.source }
        return e
      })

      await db.scheduleEntries.insertMany(
        finalEntries.map((e) => ({ ...e, schedule_id: sch!.id })),
      )
      setViolations(allViolations)
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

  async function onClear() {
    if (!schedule) return
    if (!confirm(`Borrar el cronograma de ${targetMonth.slice(0, 7)}? Esta acción no se puede deshacer.`)) return
    setBusy(true)
    try {
      await db.scheduleEntries.removeWhere((e) => e.schedule_id === schedule.id)
      await db.schedules.remove(schedule.id)
      setViolations([])
      await reload()
    } catch (err) {
      console.error('Clear failed:', err)
      alert(`Error al borrar: ${err instanceof Error ? err.message : String(err)}`)
    } finally {
      setBusy(false)
    }
  }

  async function onCellChange(employeeId: string, date: string, shift: Shift) {
    if (!schedule) return
    const existing = entries.find((e) => e.employee_id === employeeId && e.date === date)
    const previousShift: Shift = existing?.shift ?? 'off'
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

    // Auto-cover when marking sick on a previously-working cell that has
    // no other coverage that day for the same shift.
    if (
      shift === 'sick' &&
      (previousShift === 'morning' ||
        previousShift === 'afternoon' ||
        previousShift === 'night' ||
        previousShift === 'partido')
    ) {
      const sameShiftOthers = entries.filter(
        (e) => e.date === date && e.employee_id !== employeeId && e.shift === previousShift,
      )
      if (sameShiftOthers.length === 0) {
        const dayEntries = entries.filter((e) => e.date === date)
        const replacement = employees.find((emp) => {
          if (emp.id === employeeId) return false
          if (!shiftAllowedFor(emp, previousShift)) return false
          const myEntry = dayEntries.find((de) => de.employee_id === emp.id)
          if (!myEntry) return true
          // Only replace someone who was off — don't override another shift,
          // vacation, holiday, personal, or another sick.
          return myEntry.shift === 'off'
        })
        if (replacement) {
          const repEntry = entries.find(
            (e) => e.employee_id === replacement.id && e.date === date,
          )
          if (repEntry) {
            await db.scheduleEntries.update(repEntry.id, {
              shift: previousShift,
              source: 'manual',
            })
          } else {
            await db.scheduleEntries.insert({
              schedule_id: schedule.id,
              employee_id: replacement.id,
              date,
              shift: previousShift,
              source: 'manual',
            })
          }
          alert(
            `Turno de ${shiftTitle(previousShift).toLowerCase()} cubierto por ${replacement.full_name}`,
          )
        } else {
          alert(
            `Sin reemplazo disponible para el turno de ${shiftTitle(previousShift).toLowerCase()} del ${date} — asignalo a mano.`,
          )
        }
      }
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
        <div className="actions">
          <select value={departmentId} onChange={(e) => setDepartmentId(e.target.value)}>
            {departments.length === 0 && <option value="">— sin departamentos —</option>}
            {departments.map((d) => (
              <option key={d.id} value={d.id}>{d.name}</option>
            ))}
          </select>
          <input
            type="month"
            value={targetMonth.slice(0, 7)}
            onChange={(e) => setTargetMonth(`${e.target.value}-01`)}
          />
        </div>
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
          <button className="link danger" onClick={onClear} disabled={busy}>
            Borrar
          </button>
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
                {[...employees].sort((a, b) => {
                  const ca = categories.find((c) => c.id === a.category_id)?.name ?? ''
                  const cb = categories.find((c) => c.id === b.category_id)?.name ?? ''
                  if (ca !== cb) return ca.localeCompare(cb)
                  return a.full_name.localeCompare(b.full_name)
                }).map((e) => (
                  <tr key={e.id}>
                    <td className="sticky-col">
                      <div>{e.full_name}</div>
                      <div className="muted small">
                        {categories.find((c) => c.id === e.category_id)?.name ?? '—'}
                      </div>
                    </td>
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
                            <option value="night">N</option>
                            <option value="partido">P</option>
                            <option value="vacation">V</option>
                            <option value="holiday">F</option>
                            <option value="personal">DP</option>
                            <option value="sick">B</option>
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
