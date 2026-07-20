import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react'
import type { ReactNode } from 'react'
import { api, ApiError } from '../api/client'
import type { TaskItemDto } from '../api/types'

/**
 * All household tasks (every profile), refreshed on an interval and after each mutation. The
 * dashboard TASKS section and the To-Do screen both read from here; the To-Do screen filters by
 * owner locally. Writes belong to the profile they target (normally the active profile).
 */
interface TasksState {
  tasks: TaskItemDto[]
  loading: boolean
  offline: boolean
  refresh: () => Promise<void>
}

const TasksContext = createContext<TasksState | null>(null)

const POLL_MS = 2 * 60_000

export function TasksProvider({ children }: { children: ReactNode }) {
  const [tasks, setTasks] = useState<TaskItemDto[]>([])
  const [loading, setLoading] = useState(true)
  const [offline, setOffline] = useState(false)

  const refresh = useCallback(async () => {
    try {
      setTasks(await api.getTasks())
      setOffline(false)
    } catch (err) {
      if (err instanceof ApiError) setOffline(true)
      else throw err
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    let cancelled = false
    const tick = async () => {
      if (!cancelled) await refresh()
    }
    void tick()
    const id = window.setInterval(tick, POLL_MS)
    return () => {
      cancelled = true
      window.clearInterval(id)
    }
  }, [refresh])

  const value = useMemo<TasksState>(() => ({ tasks, loading, offline, refresh }), [tasks, loading, offline, refresh])

  return <TasksContext.Provider value={value}>{children}</TasksContext.Provider>
}

// eslint-disable-next-line react-refresh/only-export-components
export function useTasks(): TasksState {
  const ctx = useContext(TasksContext)
  if (!ctx) throw new Error('useTasks must be used within a TasksProvider')
  return ctx
}
