import { useEffect, useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { DrillInHeader, ScreenShell, ScrollArea } from '../components'
import { Icon } from '../icons/Icon'
import { useSession } from '../app/SessionProvider'
import { useTasks } from '../app/TasksProvider'
import { getShowToday, getShowAll } from '../app/todoPrefs'
import type { TaskItemDto } from '../api/types'

const ACTIVE_LIST_KEY = 'homehub.todo.activeList'

type Urgency = 'overdue' | 'today' | 'soon' | 'later' | ''

/** Relative due label + urgency class for a task row. */
function dueInfo(task: TaskItemDto): { label: string; urgency: Urgency } {
  if (!task.dueUtc) return { label: '', urgency: '' }
  const due = new Date(task.dueUtc)
  const now = new Date()
  const days = Math.round(
    (new Date(due.getFullYear(), due.getMonth(), due.getDate()).getTime() -
      new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime()) / 86_400_000,
  )
  if (days < 0) return { label: 'Overdue', urgency: 'overdue' }
  if (days === 0) return { label: 'Today', urgency: 'today' }
  if (days === 1) return { label: 'Tomorrow', urgency: 'soon' }
  if (days <= 6) return { label: due.toLocaleDateString('en-US', { weekday: 'short' }), urgency: 'later' }
  return { label: due.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }), urgency: 'later' }
}

/**
 * TODO (spec 03, revamped): its own bottom-nav tab. Content mirrors Microsoft To Do for the
 * signed-in profile — no owner axis, the only axis is **lists**. List tabs (conditional Today · All
 * · each synced list); "All" groups by list, a single list flattens; a collapsible Completed group;
 * an add-a-task bar targeting the current list. (Sign-in gating, the Profile/Settings + Choose-lists
 * screens, and ★ write-back are follow-ups; ★ is read-only for now.)
 */
export function TodoScreen() {
  const navigate = useNavigate()
  const { activeProfile } = useSession()
  const { tasks, toggleTask, createTask, offline } = useTasks()

  // The signed-in profile's own tasks (fallback to all until sign-in gating lands).
  const myTasks = useMemo(
    () => (activeProfile ? tasks.filter((t) => t.profileId === activeProfile.id) : tasks),
    [tasks, activeProfile],
  )
  const listNames = useMemo(() => {
    const s = new Set<string>()
    for (const t of myTasks) if (t.listName) s.add(t.listName)
    return [...s].sort((a, b) => a.localeCompare(b))
  }, [myTasks])
  const hasDue = useMemo(() => myTasks.some((t) => !t.completed && t.dueUtc), [myTasks])
  // The special Today/All tabs are user-toggleable (Settings); Today also needs a due item to exist.
  const showTodayTab = getShowToday() && hasDue
  const showAllTab = getShowAll()

  const [activeList, setActiveList] = useState<string>(() => localStorage.getItem(ACTIVE_LIST_KEY) ?? 'all')
  useEffect(() => localStorage.setItem(ACTIVE_LIST_KEY, activeList), [activeList])
  // Keep the active tab valid as tabs appear/disappear (prefs, due-dates, lists).
  useEffect(() => {
    const available = [...(showTodayTab ? ['today'] : []), ...(showAllTab ? ['all'] : []), ...listNames]
    if (available.length > 0 && !available.includes(activeList)) setActiveList(available[0])
  }, [activeList, showTodayTab, showAllTab, listNames])

  const [draft, setDraft] = useState('')
  const [showCompleted, setShowCompleted] = useState(false)

  const open = myTasks.filter((t) => !t.completed)
  const done = myTasks.filter((t) => t.completed)
  const onList = activeList !== 'all' && activeList !== 'today'
  const completedVisible = onList ? done.filter((t) => t.listName === activeList) : done

  // New tasks target the active list (first list on All/Today).
  const targetList = onList ? activeList : listNames[0] ?? 'Tasks'
  const targetGraphListId = myTasks.find((t) => t.listName === targetList)?.graphListId ?? null

  const toggle = (t: TaskItemDto) => void toggleTask(t)
  const add = async () => {
    const title = draft.trim()
    if (!title || !activeProfile) return
    setDraft('')
    await createTask({ profileId: activeProfile.id, title, note: null, dueUtc: null, listName: targetList, graphListId: targetGraphListId })
  }

  const groups = buildGroups(activeList, open, listNames)

  return (
    <ScreenShell
      header={
        <DrillInHeader
          title="TODO"
          onBack={() => navigate('/')}
          status={
            <span className={'ml-todo__sync' + (offline ? ' ml-todo__sync--off' : '')}>
              <span className="ml-todo__syncdot" aria-hidden="true" />
              {offline ? 'Offline' : 'Synced'}
            </span>
          }
        />
      }
    >
      <div className="ml-todo__listtabs" role="tablist">
        {showTodayTab && <ListTab label="Today" active={activeList === 'today'} onClick={() => setActiveList('today')} />}
        {showAllTab && <ListTab label="All" active={activeList === 'all'} onClick={() => setActiveList('all')} />}
        {listNames.map((name) => (
          <ListTab key={name} label={name} active={activeList === name} onClick={() => setActiveList(name)} />
        ))}
      </div>

      <ScrollArea>
        {open.length === 0 && completedVisible.length === 0 ? (
          <div className="ml-todo__empty">
            <Icon id="ico-todo" size="2rem" />
            <span>Nothing to do here</span>
          </div>
        ) : (
          groups.map((g) => (
            <div className="ml-todo__group" key={g.key}>
              {g.header && (
                <div className="ml-todo__grouphead">
                  <span className="ml-todo__grouptick" aria-hidden="true" />
                  <span className="ml-todo__grouplabel">{g.header}</span>
                  <span className="ml-todo__groupcount">{g.tasks.length}</span>
                </div>
              )}
              {g.tasks.map((t) => (
                <TaskRow key={t.id} task={t} onToggle={() => toggle(t)} showList={activeList === 'today'} />
              ))}
            </div>
          ))
        )}

        {completedVisible.length > 0 && (
          <div className="ml-todo__completed">
            <button type="button" className="ml-todo__completedhead" onClick={() => setShowCompleted((v) => !v)}>
              <span aria-hidden="true">{showCompleted ? '▾' : '▸'}</span> Completed {completedVisible.length}
            </button>
            {showCompleted && completedVisible.map((t) => <TaskRow key={t.id} task={t} onToggle={() => toggle(t)} />)}
          </div>
        )}
      </ScrollArea>

      <div className="ml-todo__addbar">
        <span className="ml-todo__addplus" aria-hidden="true"><Icon id="ico-add" size="1rem" /></span>
        <input
          className="ml-todo__addfield"
          value={draft}
          placeholder="Add a task"
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && add()}
        />
        <span className="ml-todo__addtarget">{`To ${targetList}`}</span>
      </div>
    </ScreenShell>
  )
}

interface Group {
  key: string
  header: string | null
  tasks: TaskItemDto[]
}

/** Build the grouped body for the active tab: Today→urgency, All→per-list, single list→flat. */
function buildGroups(activeList: string, open: TaskItemDto[], listNames: string[]): Group[] {
  if (activeList === 'today') {
    const due = open.filter((t) => t.dueUtc)
    return (
      [
        { key: 'overdue', header: 'Overdue', match: (u: Urgency) => u === 'overdue' },
        { key: 'today', header: 'Today', match: (u: Urgency) => u === 'today' },
        { key: 'later', header: 'Later', match: (u: Urgency) => u === 'soon' || u === 'later' },
      ] as const
    )
      .map((seg) => ({ key: seg.key, header: seg.header, tasks: due.filter((t) => seg.match(dueInfo(t).urgency)) }))
      .filter((g) => g.tasks.length > 0)
  }
  if (activeList === 'all') {
    return listNames
      .map((name) => ({ key: name, header: name, tasks: open.filter((t) => t.listName === name) }))
      .filter((g) => g.tasks.length > 0)
  }
  return [{ key: activeList, header: null, tasks: open.filter((t) => t.listName === activeList) }]
}

function ListTab({ label, active, onClick }: { label: string; active: boolean; onClick: () => void }) {
  return (
    <button type="button" role="tab" aria-selected={active} className={'ml-todo__listtab' + (active ? ' ml-todo__listtab--active' : '')} onClick={onClick}>
      {label}
    </button>
  )
}

function TaskRow({ task, onToggle, showList }: { task: TaskItemDto; onToggle: () => void; showList?: boolean }) {
  const { label, urgency } = dueInfo(task)
  return (
    <div className={'ml-todorow' + (task.completed ? ' ml-todorow--done' : '')}>
      <button type="button" className="ml-todorow__check" onClick={onToggle} aria-pressed={task.completed} aria-label="Toggle complete">
        {task.completed && <Icon id="ico-check" size="1rem" />}
      </button>
      <div className="ml-todorow__main">
        <div className="ml-todorow__title">{task.title}</div>
        {(label || (showList && task.listName)) && (
          <div className="ml-todorow__meta">
            {label && <span className={'ml-todorow__due ml-todorow__due--' + urgency}>{label}</span>}
            {showList && task.listName && <span className="ml-todorow__listtag">{task.listName}</span>}
          </div>
        )}
      </div>
      <span className={'ml-todorow__star' + (task.important ? ' ml-todorow__star--on' : '')} aria-hidden="true">
        {task.important ? '★' : '☆'}
      </span>
    </div>
  )
}
