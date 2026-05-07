import { useEffect, useState } from 'react'
import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom'
import { useSession } from './hooks/useSession'
import { hasAnySupervisor } from './lib/session'
import { runMigrations, seedIfEmpty } from './lib/db'
import Login from './pages/Login'
import Setup from './pages/Setup'
import Layout from './components/Layout'
import Employees from './pages/supervisor/Employees'
import Settings from './pages/supervisor/Settings'
import Requests from './pages/supervisor/Requests'
import SupervisorSchedule from './pages/supervisor/Schedule'
import Calendar from './pages/supervisor/Calendar'
import Peaks from './pages/supervisor/Peaks'
import EmployeeRequest from './pages/employee/Request'
import MySchedule from './pages/employee/MySchedule'

function App() {
  const session = useSession()
  const [needsSetup, setNeedsSetup] = useState<boolean | null>(null)

  useEffect(() => {
    ;(async () => {
      await seedIfEmpty()
      await runMigrations()
      setNeedsSetup(!(await hasAnySupervisor()))
    })()
  }, [session?.userId])

  if (needsSetup === null) {
    return <main className="auth"><div className="card"><p>Cargando...</p></div></main>
  }

  return (
    <BrowserRouter basename="/gestion-horarios">
      <Routes>
        {needsSetup ? (
          <>
            <Route path="/setup" element={<Setup />} />
            <Route path="*" element={<Navigate to="/setup" replace />} />
          </>
        ) : !session ? (
          <>
            <Route path="/login" element={<Login />} />
            <Route path="*" element={<Navigate to="/login" replace />} />
          </>
        ) : session.role === 'supervisor' ? (
          <Route element={<Layout />}>
            <Route path="/supervisor" element={<SupervisorSchedule />} />
            <Route path="/supervisor/employees" element={<Employees />} />
            <Route path="/supervisor/settings" element={<Settings />} />
            <Route path="/supervisor/requests" element={<Requests />} />
            <Route path="/supervisor/calendar" element={<Calendar />} />
            <Route path="/supervisor/peaks" element={<Peaks />} />
            <Route path="*" element={<Navigate to="/supervisor" replace />} />
          </Route>
        ) : (
          <Route element={<Layout />}>
            <Route path="/employee" element={<MySchedule />} />
            <Route path="/employee/request" element={<EmployeeRequest />} />
            <Route path="*" element={<Navigate to="/employee" replace />} />
          </Route>
        )}
      </Routes>
    </BrowserRouter>
  )
}

export default App
