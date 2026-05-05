import { db } from './db'
import type { Employee, Supervisor } from '../types/database'

export type Role = 'supervisor' | 'employee'

export interface Session {
  role: Role
  userId: string
  dni: string
  fullName: string
}

const KEY = 'gh:session'

export function getSession(): Session | null {
  try {
    const raw = localStorage.getItem(KEY)
    return raw ? (JSON.parse(raw) as Session) : null
  } catch {
    return null
  }
}

export function setSession(s: Session): void {
  localStorage.setItem(KEY, JSON.stringify(s))
}

export function clearSession(): void {
  localStorage.removeItem(KEY)
}

export async function loginByDNI(dni: string): Promise<Session | null> {
  const trimmed = dni.trim().toUpperCase()
  if (!trimmed) return null

  const supervisors = await db.supervisors.list()
  const sup = supervisors.find((s) => s.dni.toUpperCase() === trimmed)
  if (sup) {
    const session: Session = {
      role: 'supervisor',
      userId: sup.id,
      dni: sup.dni,
      fullName: sup.full_name,
    }
    setSession(session)
    return session
  }

  const employees = await db.employees.list()
  const emp = employees.find((e) => e.dni.toUpperCase() === trimmed && e.active)
  if (emp) {
    const session: Session = {
      role: 'employee',
      userId: emp.id,
      dni: emp.dni,
      fullName: emp.full_name,
    }
    setSession(session)
    return session
  }

  return null
}

export async function hasAnySupervisor(): Promise<boolean> {
  const list = await db.supervisors.list()
  return list.length > 0
}

export async function getCurrentUser(): Promise<Supervisor | Employee | null> {
  const s = getSession()
  if (!s) return null
  if (s.role === 'supervisor') return await db.supervisors.byId(s.userId)
  return await db.employees.byId(s.userId)
}
