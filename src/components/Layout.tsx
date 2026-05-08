import { NavLink, Outlet, useNavigate } from 'react-router-dom'
import {
  CalendarDays,
  CalendarRange,
  TrendingUp,
  Inbox,
  Users,
  Settings,
  LogOut,
  type LucideIcon,
} from 'lucide-react'
import logoUrl from '../assets/logo.png'
import { useSession, notifySessionChange } from '../hooks/useSession'
import { clearSession } from '../lib/session'

interface NavItem {
  to: string
  label: string
  Icon: LucideIcon
}

const SUPERVISOR_NAV: NavItem[] = [
  { to: '/supervisor', label: 'Cronograma', Icon: CalendarDays },
  { to: '/supervisor/calendar', label: 'Calendario', Icon: CalendarRange },
  { to: '/supervisor/peaks', label: 'Picos', Icon: TrendingUp },
  { to: '/supervisor/requests', label: 'Solicitudes', Icon: Inbox },
  { to: '/supervisor/employees', label: 'Empleados', Icon: Users },
  { to: '/supervisor/settings', label: 'Ajustes', Icon: Settings },
]

const EMPLOYEE_NAV: NavItem[] = [
  { to: '/employee', label: 'Mi horario', Icon: CalendarDays },
  { to: '/employee/request', label: 'Solicitudes', Icon: Inbox },
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
        <div className="topbar-title">
          <img src={logoUrl} alt="" className="topbar-logo" />
          <span>Gestión de Horarios</span>
        </div>
        <div className="topbar-user">
          <span className="topbar-user-name">{session.fullName}</span>
          <button className="ghost icon-only" onClick={logout} title="Salir">
            <LogOut size={18} />
          </button>
        </div>
      </header>
      <main className="content">
        <Outlet />
      </main>
      <nav className="bottomnav">
        {items.map((it) => (
          <NavLink
            key={it.to}
            to={it.to}
            end={it.to.endsWith('supervisor') || it.to.endsWith('employee')}
          >
            <it.Icon size={20} strokeWidth={2} />
            <span className="nav-label">{it.label}</span>
          </NavLink>
        ))}
      </nav>
    </div>
  )
}
