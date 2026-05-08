import { useEffect, useMemo, useRef, useState } from 'react'
import {
  RefreshCw,
  CheckCircle2,
  FileText,
  Share2,
  MoreHorizontal,
  Sparkles,
} from 'lucide-react'
import { db } from '../../lib/db'
import {
  carryOverFromEntries,
  generateSchedule,
  type Violation,
} from '../../lib/schedule'
import { eachDayInMonth, fromISO, monthKey, nextMonth, toISO } from '../../lib/dates'
import type {
  Category,
  CoverageOverride,
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
  return (emp.shifts ?? ['morning', 'afternoon']).includes(shift)
}

const SHIFT_LETTER: Record<Shift, string> = {
  off: 'L',
  morning: 'M',
  afternoon: 'T',
  night: 'N',
  partido: 'P',
  vacation: 'V',
  holiday: 'F',
  personal: 'DP',
  sick: 'B',
}

const CELL_OPTIONS: Shift[] = [
  'off',
  'morning',
  'afternoon',
  'night',
  'partido',
  'vacation',
  'holiday',
  'personal',
  'sick',
]

export default function SupervisorSchedule() {
  const [targetMonth, setTargetMonth] = useState<string>(monthKey(nextMonth(new Date())))
  const [departments, setDepartments] = useState<Department[]>([])
  const [categories, setCategories] = useState<Category[]>([])
  const [scope, setScope] = useState<string>('')
  const [employees, setEmployees] = useState<Employee[]>([])
  const [schedule, setSchedule] = useState<Schedule | null>(null)
  const [entries, setEntries] = useState<ScheduleEntry[]>([])
  const [violations, setViolations] = useState<Violation[]>([])
  const [requests, setRequests] = useState<DayRequest[]>([])
  const [holidays, setHolidays] = useState<PublicHoliday[]>([])
  const [overrides, setOverrides] = useState<CoverageOverride[]>([])
  const [busy, setBusy] = useState(false)
  const [overflowOpen, setOverflowOpen] = useState(false)
  const [editingCell, setEditingCell] = useState<{
    employeeId: string
    date: string
    shift: Shift
  } | null>(null)
  const overflowRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!overflowOpen) return
    function onClick(e: MouseEvent) {
      if (overflowRef.current && !overflowRef.current.contains(e.target as Node)) {
        setOverflowOpen(false)
      }
    }
    document.addEventListener('click', onClick)
    return () => document.removeEventListener('click', onClick)
  }, [overflowOpen])

  async function reload() {
    const [emps, schedulesAll, requestsAll, holidaysAll, deptsAll, catsAll, ovsAll] =
      await Promise.all([
        db.employees.list(),
        db.schedules.list(),
        db.dayRequests.list(),
        db.publicHolidays.list(),
        db.departments.list(),
        db.categories.list(),
        db.coverageOverrides.list(),
      ])
    setOverrides(ovsAll)
    setDepartments(deptsAll)
    setCategories(catsAll)
    let currentScope = scope
    if (!currentScope && deptsAll.length > 0) {
      currentScope = `dept:${deptsAll[0].id}`
      setScope(currentScope)
    }
    const [kind, id] = currentScope.split(':')
    let dept = ''
    let scopedCatIds: string[] = []
    if (kind === 'cat') {
      const cat = catsAll.find((c) => c.id === id)
      dept = cat?.department_id ?? ''
      scopedCatIds = cat ? [cat.id] : []
    } else if (kind === 'dept') {
      dept = id
      scopedCatIds = catsAll.filter((c) => c.department_id === id).map((c) => c.id)
    }
    const active = emps.filter((e) => e.active && e.category_id && scopedCatIds.includes(e.category_id))
    setEmployees(active)
    setRequests(requestsAll)
    setHolidays(holidaysAll)
    const sch =
      dept ? schedulesAll.find((s) => s.month === targetMonth && s.department_id === dept) ?? null : null
    setSchedule(sch)
    if (sch) {
      const allEntries = await db.scheduleEntries.list()
      // When scoped to a single category, only show entries of that category's employees.
      const empIds = new Set(active.map((e) => e.id))
      setEntries(allEntries.filter((e) => e.schedule_id === sch.id && empIds.has(e.employee_id)))
    } else {
      setEntries([])
    }
  }

  useEffect(() => {
    reload()
  }, [targetMonth, scope])

  // Derived values used across handlers and rendering.
  const scopeKind = scope.split(':')[0] as '' | 'dept' | 'cat'
  const scopeIdValue = scope.split(':')[1] ?? ''
  const departmentId = useMemo(() => {
    if (scopeKind === 'cat') {
      return categories.find((c) => c.id === scopeIdValue)?.department_id ?? ''
    }
    if (scopeKind === 'dept') return scopeIdValue
    return ''
  }, [scopeKind, scopeIdValue, categories])
  const scopedCategoryIds = useMemo(() => {
    if (scopeKind === 'cat') return new Set<string>(scopeIdValue ? [scopeIdValue] : [])
    if (scopeKind === 'dept') {
      return new Set(
        categories.filter((c) => c.department_id === scopeIdValue).map((c) => c.id),
      )
    }
    return new Set<string>()
  }, [scopeKind, scopeIdValue, categories])

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
        // reflected on the next regenerate. When scoped to a single
        // category, only the entries of that category's employees are
        // wiped — entries of other categories in the same department are
        // left untouched.
        const scopedEmpIds = new Set(employees.map((e) => e.id))
        const existing = (await db.scheduleEntries.list()).filter(
          (e) => e.schedule_id === sch!.id && scopedEmpIds.has(e.employee_id),
        )
        manualEntries = existing.filter((e) => e.source === 'manual')
        await db.scheduleEntries.removeWhere(
          (e) => e.schedule_id === sch!.id && scopedEmpIds.has(e.employee_id),
        )
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
      // coverage config (M/T/N/P). Merge the resulting entries. When
      // the user scoped the view to a single category, only that one
      // gets regenerated.
      const catsInDept = categories.filter(
        (c) => c.department_id === departmentId && scopedCategoryIds.has(c.id),
      )
      const generatedEntries: Omit<ScheduleEntry, 'id' | 'schedule_id'>[] = []
      const allViolations: Violation[] = []
      for (const cat of catsInDept) {
        const catEmployees = employees.filter((e) => e.category_id === cat.id)
        if (catEmployees.length === 0) continue
        const catEmpIds = new Set(catEmployees.map((e) => e.id))
        const catApproved = allApproved.filter((r) => catEmpIds.has(r.employee_id))
        const catOverrides = overrides.filter((o) => o.category_id === cat.id)
        const result = generateSchedule({
          monthISO: targetMonth,
          employees: catEmployees,
          approvedRequests: catApproved,
          holidays,
          carryOver: carryOverFromEntries(prevEntries, targetMonth),
          restDaysPerYear: settings.rest_days_per_year,
          coverage: cat.coverage,
          coverageOverrides: catOverrides,
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

  async function buildPdf() {
    const dept = departments.find((d) => d.id === departmentId)
    const { buildSchedulePdf } = await import('../../lib/exportPdf')
    return buildSchedulePdf({
      monthISO: targetMonth,
      departmentName: dept?.name ?? 'Cronograma',
      employees,
      categories,
      entries,
    })
  }

  async function onDownloadPdf() {
    if (!schedule) return
    const { downloadPdf } = await import('../../lib/exportPdf')
    downloadPdf(await buildPdf())
  }

  async function onSharePdf() {
    if (!schedule) return
    const dept = departments.find((d) => d.id === departmentId)
    const monthLabel = targetMonth.slice(0, 7)
    const text = `Cronograma — ${dept?.name ?? ''} — ${monthLabel}`
    const { sharePdf } = await import('../../lib/exportPdf')
    const pdf = await buildPdf()
    const result = await sharePdf(pdf, text)
    if (result === 'downloaded') {
      const ok = confirm(
        'Tu navegador no permite compartir archivos directamente. El PDF se descargó.\n\n¿Querés abrir WhatsApp Web o tu cliente de mail con un mensaje sugerido? (después adjuntás el PDF a mano)',
      )
      if (ok) {
        const choice = prompt('Escribí "wa" para WhatsApp o "mail" para email', 'wa')
        if (choice === 'wa') {
          window.open(`https://wa.me/?text=${encodeURIComponent(text)}`, '_blank')
        } else if (choice === 'mail') {
          window.open(`mailto:?subject=${encodeURIComponent(text)}&body=${encodeURIComponent(text + '\n\n(Adjuntá el PDF descargado)')}`, '_blank')
        }
      }
    }
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
            onChange={(e) => setTargetMonth(`${e.target.value}-01`)}
          />
        </div>
      </header>

      <div className="action-bar">
        <div className="action-bar-left">
          <button onClick={onGenerate} disabled={busy || employees.length === 0}>
            {schedule ? <RefreshCw size={16} /> : <Sparkles size={16} />}
            {busy ? 'Generando…' : schedule ? 'Regenerar' : 'Generar propuesta'}
          </button>
          {schedule && schedule.status === 'draft' && (
            <button className="secondary" onClick={onPublish}>
              <CheckCircle2 size={16} /> Publicar
            </button>
          )}
          {schedule && (
            <span className={`badge status-${schedule.status}`}>
              {schedule.status === 'published' ? 'Publicado' : 'Borrador'}
            </span>
          )}
        </div>
        {schedule && (
          <div className="action-bar-right">
            <button className="ghost" onClick={onDownloadPdf} title="Descargar PDF">
              <FileText size={16} /> <span className="action-label">PDF</span>
            </button>
            <button className="ghost" onClick={onSharePdf} title="Compartir">
              <Share2 size={16} /> <span className="action-label">Compartir</span>
            </button>
            <div className="overflow-wrap" ref={overflowRef}>
              <button
                className="ghost icon-only"
                onClick={() => setOverflowOpen((v) => !v)}
                aria-label="Más opciones"
              >
                <MoreHorizontal size={18} />
              </button>
              {overflowOpen && (
                <div className="overflow-menu" role="menu">
                  {schedule.status === 'published' && (
                    <button
                      className="ghost"
                      onClick={() => {
                        setOverflowOpen(false)
                        onUnpublish()
                      }}
                    >
                      Despublicar
                    </button>
                  )}
                  <button
                    className="ghost danger"
                    onClick={() => {
                      setOverflowOpen(false)
                      onClear()
                    }}
                    disabled={busy}
                  >
                    Borrar cronograma
                  </button>
                </div>
              )}
            </div>
          </div>
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
                  {days.map((d) => {
                    const dISO = toISO(d)
                    const dayOverrides = overrides.filter(
                      (o) =>
                        dISO >= o.start_date &&
                        dISO <= o.end_date &&
                        scopedCategoryIds.has(o.category_id),
                    )
                    const tooltip = dayOverrides
                      .map((o) => {
                        const cat = categories.find((c) => c.id === o.category_id)?.name ?? ''
                        const sLabel = { morning: 'M', afternoon: 'T', night: 'N', partido: 'P' }[o.shift]
                        const range =
                          o.min !== null && o.max !== null
                            ? `${o.min}-${o.max}`
                            : o.min !== null
                              ? `mín ${o.min}`
                              : o.max !== null
                                ? `máx ${o.max}`
                                : ''
                        return `${cat} ${sLabel} ${range}${o.notes ? ` — ${o.notes}` : ''}`
                      })
                      .join('\n')
                    return (
                      <th
                        key={dISO}
                        className={[
                          holidayDates.has(dISO) ? 'holiday' : '',
                          d.getDay() === 0 || d.getDay() === 6 ? 'weekend' : '',
                          dayOverrides.length > 0 ? 'has-peak' : '',
                        ].join(' ')}
                        title={tooltip || undefined}
                      >
                        <div>{format(d, 'd')}</div>
                        <div className="dow">{['D','L','M','X','J','V','S'][d.getDay()]}</div>
                        {dayOverrides.length > 0 && <div className="peak-dot" aria-hidden>•</div>}
                      </th>
                    )
                  })}
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
                          <button
                            className="cell-btn"
                            title={shiftTitle(shift)}
                            onClick={() =>
                              setEditingCell({ employeeId: e.id, date: dISO, shift })
                            }
                          >
                            {SHIFT_LETTER[shift]}
                          </button>
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
      {editingCell && (() => {
        const emp = employees.find((x) => x.id === editingCell.employeeId)
        const dateLabel = format(fromISO(editingCell.date), 'EEEE d MMM')
        const close = () => setEditingCell(null)
        return (
          <div className="modal-backdrop" onClick={close}>
            <div className="modal cell-sheet" onClick={(e) => e.stopPropagation()}>
              <div className="cell-sheet-head">
                <div>
                  <strong>{emp?.full_name ?? '—'}</strong>
                  <div className="muted small" style={{ textTransform: 'capitalize' }}>
                    {dateLabel}
                  </div>
                </div>
                <button className="ghost icon-only" onClick={close}>✕</button>
              </div>
              <div className="cell-grid">
                {CELL_OPTIONS.map((s) => (
                  <button
                    key={s}
                    className={`cell-chip shift-${s} ${s === editingCell.shift ? 'active' : ''}`}
                    onClick={async () => {
                      await onCellChange(editingCell.employeeId, editingCell.date, s)
                      close()
                    }}
                  >
                    <span className="cell-chip-letter">{SHIFT_LETTER[s]}</span>
                    <span className="cell-chip-label">{shiftTitle(s)}</span>
                  </button>
                ))}
              </div>
            </div>
          </div>
        )
      })()}
    </section>
  )
}
