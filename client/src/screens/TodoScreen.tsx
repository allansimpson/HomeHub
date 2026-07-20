import { useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { DrillInHeader, ScreenShell, ScrollArea, Chip } from '../components'
import { Icon } from '../icons/Icon'
import { useSession } from '../app/SessionProvider'
import { useTasks } from '../app/TasksProvider'
import type { ProfileDto, TaskItemDto } from '../api/types'

/** Relative due-date meta for a task row. */
function dueMeta(task: TaskItemDto): string {
  if (task.completed) return 'Done'
  if (!task.dueUtc) return ''
  const due = new Date(task.dueUtc)
  const now = new Date()
  const days = Math.round((new Date(due.getFullYear(), due.getMonth(), due.getDate()).getTime()
    - new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime()) / 86_400_000)
  if (days < 0) return 'Overdue'
  if (days === 0) return 'Due today'
  if (days === 1) return 'Due tomorrow'
  if (days <= 6) return `Due ${due.toLocaleDateString('en-US', { weekday: 'long' })}`
  return `Due ${due.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}`
}

/**
 * To-Do (spec 03): owner filter tabs (Everyone + members), checkable task rows (done = filled
 * brass + strike + dimmed row), and a full-width New Task entry. The active profile is the
 * default owner for new tasks; add/complete/delete round-trip through the task provider.
 */
export function TodoScreen() {
  const navigate = useNavigate()
  const { profiles, activeProfile } = useSession()
  const { tasks, toggleTask, deleteTask, createTask } = useTasks()
  const [filter, setFilter] = useState<number | 'all'>('all')

  const [adding, setAdding] = useState(false)
  const [draftTitle, setDraftTitle] = useState('')
  const [draftOwner, setDraftOwner] = useState<number | null>(null)

  const visible = useMemo(
    () => (filter === 'all' ? tasks : tasks.filter((t) => t.profileId === filter)),
    [tasks, filter],
  )
  const done = visible.filter((t) => t.completed).length

  const owner = draftOwner ?? (filter !== 'all' ? filter : activeProfile?.id ?? profiles[0]?.id ?? null)

  const toggle = (task: TaskItemDto) => void toggleTask(task)
  const remove = (task: TaskItemDto) => void deleteTask(task)

  const add = async () => {
    if (!draftTitle.trim() || owner == null) return
    await createTask({ profileId: owner, title: draftTitle.trim(), note: null, dueUtc: null })
    setDraftTitle('')
    setAdding(false)
  }

  return (
    <ScreenShell
      header={<DrillInHeader title="Tasks" status={`${done} of ${visible.length} done`} onBack={() => navigate('/')} />}
    >
      <div className="ml-todo__tabs">
        <Chip label="Everyone" active={filter === 'all'} onClick={() => setFilter('all')} />
        {profiles.map((p) => (
          <Chip key={p.id} label={p.name} active={filter === p.id} onClick={() => setFilter(p.id)} />
        ))}
      </div>

      <ScrollArea>
        {visible.length === 0 && !adding ? (
          <div className="ml-cal-empty">No tasks</div>
        ) : (
          visible.map((t) => (
            <TaskRow key={t.id} task={t} profiles={profiles} onToggle={() => toggle(t)} onDelete={() => remove(t)} />
          ))
        )}

        {adding && (
          <div className="ml-todo__add">
            <input
              className="ml-fieldinput ml-todo__addinput"
              value={draftTitle}
              placeholder="What needs doing…"
              autoFocus
              onChange={(e) => setDraftTitle(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') add()
                if (e.key === 'Escape') setAdding(false)
              }}
            />
            <div className="ml-todo__addowners">
              {profiles.map((p) => (
                <Chip key={p.id} label={p.name} active={owner === p.id} onClick={() => setDraftOwner(p.id)} />
              ))}
            </div>
            <div className="ml-todo__addactions">
              <button type="button" className="ml-linkbtn" onClick={() => setAdding(false)}>Cancel</button>
              <button type="button" className="ml-linkbtn" onClick={add} disabled={!draftTitle.trim()}>Add task</button>
            </div>
          </div>
        )}
      </ScrollArea>

      {!adding && (
        <button type="button" className="ml-todo__new" onClick={() => setAdding(true)}>
          ＋ New Task
        </button>
      )}
    </ScreenShell>
  )
}

function TaskRow({
  task, profiles, onToggle, onDelete,
}: {
  task: TaskItemDto
  profiles: ProfileDto[]
  onToggle: () => void
  onDelete: () => void
}) {
  const owner = profiles.find((p) => p.id === task.profileId)
  const meta = dueMeta(task)
  return (
    <div className={'ml-task' + (task.completed ? ' ml-task--done' : '')}>
      <button type="button" className="ml-task__check" onClick={onToggle} aria-pressed={task.completed} aria-label="Toggle complete">
        {task.completed && <Icon id="ico-check" size="0.9375rem" />}
      </button>
      <div className="ml-task__main">
        <div className="ml-task__title">{task.title}</div>
        {meta && <div className="ml-task__meta">{meta}</div>}
      </div>
      {owner && <span className="ml-ownerchip ml-task__owner">{owner.initial}</span>}
      <button type="button" className="ml-task__delete" onClick={onDelete} aria-label="Delete task">×</button>
    </div>
  )
}
