import { useState, type FormEvent } from 'react'
import { useNavigate } from 'react-router-dom'
import { loginByDNI } from '../lib/session'
import { notifySessionChange } from '../hooks/useSession'

export default function Login() {
  const navigate = useNavigate()
  const [dni, setDni] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function onSubmit(e: FormEvent) {
    e.preventDefault()
    setError(null)
    setBusy(true)
    const session = await loginByDNI(dni)
    if (!session) {
      setError('DNI no encontrado o inactivo')
      setBusy(false)
      return
    }
    notifySessionChange()
    navigate(session.role === 'supervisor' ? '/supervisor' : '/employee', { replace: true })
  }

  return (
    <main className="auth">
      <div className="card">
        <h1>Gestión de Horarios</h1>
        <p className="muted">Ingresá con tu DNI</p>
        <form onSubmit={onSubmit}>
          <label>
            DNI
            <input
              type="text"
              value={dni}
              onChange={(e) => setDni(e.target.value)}
              autoFocus
              required
            />
          </label>
          {error && <p className="error">{error}</p>}
          <button type="submit" disabled={busy}>
            {busy ? 'Entrando...' : 'Entrar'}
          </button>
        </form>
      </div>
    </main>
  )
}
