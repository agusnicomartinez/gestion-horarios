import { useEffect, useState } from 'react'
import { getSession, type Session } from '../lib/session'

export function useSession(): Session | null {
  const [session, setSession] = useState<Session | null>(getSession())

  useEffect(() => {
    function sync() {
      setSession(getSession())
    }
    window.addEventListener('storage', sync)
    window.addEventListener('gh:session-change', sync)
    return () => {
      window.removeEventListener('storage', sync)
      window.removeEventListener('gh:session-change', sync)
    }
  }, [])

  return session
}

export function notifySessionChange() {
  window.dispatchEvent(new Event('gh:session-change'))
}
