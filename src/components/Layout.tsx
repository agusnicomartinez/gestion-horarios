import { NavLink, Outlet, useNavigate } from 'react-router-dom'
import { useSession, notifySessionChange } from '../hooks/useSession'
import { clearSession } from '../lib/session'

interface NavItem {
  to: string
  label: string
  icon: string
}

const SUPERVISOR_NAV: NavItem[] = [
  { to: '/supervisor', label: 'Cronograma', icon: '📅' },
  { to: '/supervisor/calendar', label: 'Calendario', icon: '🗓️' },
  { to: '/supervisor/requests', label: 'Solicitudes', icon: '📨' },
  { to: '/supervisor/employees', label: 'Empleados', icon: '👥' },
  { to: '/supervisor/settings', label: 'Ajustes', icon: '⚙️' },
]

const EMPLOYEE_NAV: NavItem[] = [
  { to: '/employee', label: 'Mi horario', icon: '📅' },
  { to: '/employee/request', label: 'Solicitudes', icon: '📨' },
]

export default function Layout() {
  const session = useSession()
  const navigate = useNavigate()
  if (!session) return null

  const items = session.role === 'supervisor' ? SUPERVISOR_NAV : EMPLOYEE_NAV

  function logout() {
    clearSession()
    notifySessionChange()
    navigate('/login', { replace: true })
  }

  return (
    <div className="layout">
      <header className="topbar">
        <div className="topbar-title">Gestión de Horarios</div>
        <div className="topbar-user">
          <span>{session.fullName}</span>
          <button className="link" onClick={logout}>Salir</button>
        </div>
      </header>
      <main className="content">
        <Outlet />
      </main>
      <nav className="bottomnav">
        {items.map((it) => (
          <NavLink key={it.to} to={it.to} end={it.to.endsWith('supervisor') || it.to.endsWith('employee')}>
            <span className="nav-icon">{it.icon}</span>
            <span className="nav-label">{it.label}</span>
          </NavLink>
        ))}
      </nav>
    </div>
  )
}
