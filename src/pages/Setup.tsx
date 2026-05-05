import { useState, type FormEvent } from 'react'
import { useNavigate } from 'react-router-dom'
import { db } from '../lib/db'
import { setSession } from '../lib/session'
import { notifySessionChange } from '../hooks/useSession'

export default function Setup() {
  const navigate = useNavigate()
  const [dni, setDni] = useState('')
  const [name, setName] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function onSubmit(e: FormEvent) {
    e.preventDefault()
    setError(null)
    if (!dni.trim() || !name.trim()) {
      setError('DNI y nombre son obligatorios')
      return
    }
    setBusy(true)
    try {
      const sup = await db.supervisors.insert({
        dni: dni.trim().toUpperCase(),
        full_name: name.trim(),
        created_at: new Date().toISOString(),
      })
      setSession({
        role: 'supervisor',
        userId: sup.id,
        dni: sup.dni,
        fullName: sup.full_name,
      })
      notifySessionChange()
      navigate('/supervisor', { replace: true })
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Error al crear supervisor')
      setBusy(false)
    }
  }

  return (
    <main className="auth">
      <div className="card">
        <h1>Configuración inicial</h1>
        <p className="muted">
          Es la primera vez que abrís la app. Creá la cuenta del supervisor para empezar.
        </p>
        <form onSubmit={onSubmit}>
          <label>
            DNI
            <input
              type="text"
              value={dni}
              onChange={(e) => setDni(e.target.value)}
              placeholder="12345678X"
              autoFocus
              required
            />
          </label>
          <label>
            Nombre completo
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              required
            />
          </label>
          {error && <p className="error">{error}</p>}
          <button type="submit" disabled={busy}>
            {busy ? 'Creando...' : 'Crear supervisor y entrar'}
          </button>
        </form>
      </div>
    </main>
  )
}
