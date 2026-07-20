import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react'
import type { ReactNode } from 'react'
import { api, ApiError } from '../api/client'
import type { TaskItemDto, TaskCreateInput } from '../api/types'
import { useWriteQueue } from './WriteQueueProvider'

/**
 * All household tasks, refreshed on an interval and after each mutation. Mutations are optimistic
 * and go through the offline write-queue (Stage 9b): they apply locally at once, then either
 * confirm with the server or queue for replay on reconnect. A `homehub:sync` event (fired after a
 * queue replay) triggers a refresh so the UI reconciles with the server.
 */
interface TasksState {
  tasks: TaskItemDto[]
  loading: boolean
  offline: boolean
  refresh: () => Promise<void>
  toggleTask: (task: TaskItemDto) => Promise<void>
  deleteTask: (task: TaskItemDto) => Promise<void>
  createTask: (input: TaskCreateInput) => Promise<void>
}

const TasksContext = createContext<TasksState | null>(null)

const POLL_MS = 2 * 60_000

export function TasksProvider({ children }: { children: ReactNode }) {
  const { run } = useWriteQueue()
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
    const onSync = () => void refresh()
    window.addEventListener('homehub:sync', onSync)
    return () => {
      cancelled = true
      window.clearInterval(id)
      window.removeEventListener('homehub:sync', onSync)
    }
  }, [refresh])

  const toggleTask = useCallback(
    async (task: TaskItemDto) => {
      const next = !task.completed
      setTasks((cur) => cur.map((t) => (t.id === task.id ? { ...t, completed: next } : t)))
      const outcome = await run({
        domain: 'task',
        method: 'PATCH',
        path: `/tasks/${task.id}/complete`,
        body: { completed: next },
        baseVersion: task.version,
        label: `${next ? 'Complete' : 'Reopen'} “${task.title}”`,
      })
      if (outcome.kind === 'ok') setTasks((cur) => cur.map((t) => (t.id === task.id ? (outcome.data as TaskItemDto) : t)))
      else if (outcome.kind !== 'queued') await refresh() // conflict / gone / error → reconcile
    },
    [run, refresh],
  )

  const deleteTask = useCallback(
    async (task: TaskItemDto) => {
      setTasks((cur) => cur.filter((t) => t.id !== task.id))
      const outcome = await run({
        domain: 'task',
        method: 'DELETE',
        path: `/tasks/${task.id}`,
        baseVersion: task.version,
        label: `Delete “${task.title}”`,
      })
      // ok / gone (already deleted) / queued → stay removed; conflict / error → reconcile.
      if (outcome.kind === 'conflict' || outcome.kind === 'error') await refresh()
    },
    [run, refresh],
  )

  const createTask = useCallback(
    async (input: TaskCreateInput) => {
      const tempId = -Date.now()
      const optimistic: TaskItemDto = {
        id: tempId,
        profileId: input.profileId,
        title: input.title,
        note: input.note,
        dueUtc: input.dueUtc,
        completed: false,
        source: 'local',
        version: 0,
      }
      setTasks((cur) => [...cur, optimistic])
      const outcome = await run({
        domain: 'task',
        method: 'POST',
        path: '/tasks',
        body: input,
        label: `Add “${input.title}”`,
      })
      if (outcome.kind === 'ok') {
        setTasks((cur) => cur.map((t) => (t.id === tempId ? (outcome.data as TaskItemDto) : t)))
      } else if (outcome.kind !== 'queued') {
        setTasks((cur) => cur.filter((t) => t.id !== tempId))
      }
      // queued → keep the temp row; replay creates it and the next sync/refresh reconciles.
    },
    [run],
  )

  const value = useMemo<TasksState>(
    () => ({ tasks, loading, offline, refresh, toggleTask, deleteTask, createTask }),
    [tasks, loading, offline, refresh, toggleTask, deleteTask, createTask],
  )

  return <TasksContext.Provider value={value}>{children}</TasksContext.Provider>
}

// eslint-disable-next-line react-refresh/only-export-components
export function useTasks(): TasksState {
  const ctx = useContext(TasksContext)
  if (!ctx) throw new Error('useTasks must be used within a TasksProvider')
  return ctx
}
