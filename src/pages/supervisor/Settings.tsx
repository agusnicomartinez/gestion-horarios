import { useEffect, useState, type FormEvent } from 'react'
import { db } from '../../lib/db'
import type { GlobalSettings, PublicHoliday } from '../../types/database'

export default function Settings() {
  const [settings, setSettings] = useState<GlobalSettings | null>(null)
  const [holidays, setHolidays] = useState<PublicHoliday[]>([])
  const [vacation, setVacation] = useState(0)
  const [personal, setPersonal] = useState(0)
  const [holidayDays, setHolidayDays] = useState(0)
  const [savingSettings, setSavingSettings] = useState(false)
  const [newDate, setNewDate] = useState('')
  const [newDescription, setNewDescription] = useState('')

  async function reload() {
    const s = await db.settings.get()
    setSettings(s)
    setVacation(s.vacation_days_per_year)
    setPersonal(s.personal_days_per_year)
    setHolidayDays(s.holiday_days_per_year)
    const h = await db.publicHolidays.list()
    h.sort((a, b) => a.date.localeCompare(b.date))
    setHolidays(h)
  }

  useEffect(() => {
    reload()
  }, [])

  async function onSaveSettings(e: FormEvent) {
    e.preventDefault()
    setSavingSettings(true)
    await db.settings.update({
      vacation_days_per_year: vacation,
      personal_days_per_year: personal,
      holiday_days_per_year: holidayDays,
    })
    setSavingSettings(false)
    reload()
  }

  async function onAddHoliday(e: FormEvent) {
    e.preventDefault()
    if (!newDate) return
    await db.publicHolidays.insert({ date: newDate, description: newDescription })
    setNewDate('')
    setNewDescription('')
    reload()
  }

  async function onRemoveHoliday(id: string) {
    await db.publicHolidays.remove(id)
    reload()
  }

  if (!settings) return <p>Cargando...</p>

  return (
    <section>
      <h1>Ajustes</h1>

      <form className="card form" onSubmit={onSaveSettings}>
        <h2>Parámetros globales</h2>
        <label>
          Vacaciones / año
          <input type="number" min={0} value={vacation} onChange={(e) => setVacation(+e.target.value)} />
        </label>
        <label>
          Días personales / año
          <input type="number" min={0} value={personal} onChange={(e) => setPersonal(+e.target.value)} />
        </label>
        <label>
          Festivos / año
          <input type="number" min={0} value={holidayDays} onChange={(e) => setHolidayDays(+e.target.value)} />
        </label>
        <div className="actions">
          <button type="submit" disabled={savingSettings}>
            {savingSettings ? 'Guardando...' : 'Guardar'}
          </button>
        </div>
      </form>

      <div className="card">
        <h2>Festivos</h2>
        <form onSubmit={onAddHoliday} className="inline-form">
          <input type="date" value={newDate} onChange={(e) => setNewDate(e.target.value)} required />
          <input
            placeholder="Descripción"
            value={newDescription}
            onChange={(e) => setNewDescription(e.target.value)}
          />
          <button type="submit">+ Añadir</button>
        </form>
        <ul className="list">
          {holidays.length === 0 && <li className="muted">Sin festivos cargados.</li>}
          {holidays.map((h) => (
            <li key={h.id} className="row">
              <div>
                <strong>{h.date}</strong>
                <div className="muted small">{h.description || '—'}</div>
              </div>
              <button className="link danger" onClick={() => onRemoveHoliday(h.id)}>Eliminar</button>
            </li>
          ))}
        </ul>
      </div>
    </section>
  )
}
