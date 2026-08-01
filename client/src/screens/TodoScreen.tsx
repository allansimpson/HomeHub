import { useCallback, useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent, type MouseEvent as ReactMouseEvent } from 'react'
import { useNavigate } from 'react-router-dom'
import { ScreenShell, ScrollArea, EmptyState } from '../components'
import { Icon } from '../icons/Icon'
import { useSession } from '../app/SessionProvider'
import { useTasks } from '../app/TasksProvider'
import { getShowToday, getShowAll, getActiveList, setActiveList as setStoredActiveList } from '../app/todoPrefs'
import type { TaskItemDto } from '../api/types'

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
 * an add-a-task bar targeting the current list (tappable TO <list> ▾ picker). Gated on sign-in; the
 * header profile-link and the empty-state "Choose lists" route into CONFIG. ★ writes back importance.
 */
export function TodoScreen() {
  const navigate = useNavigate()
  const { activeProfile } = useSession()
  const { tasks, toggleTask, setImportant, renameTask, deleteTask, createTask, offline, loading } = useTasks()

  // The signed-in profile's own tasks (spec 03: no user data reaches TODO unless signed in).
  const myTasks = useMemo(
    () => (activeProfile ? tasks.filter((t) => t.profileId === activeProfile.id) : []),
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

  const profileId = activeProfile?.id ?? null

  /**
   * The selected tab, carried together with the profile it belongs to.
   *
   * Paired in one state value rather than held separately because the two must move atomically. On
   * the commit where the profile changes, the re-read effect below and the persist effect both run;
   * with the tab held on its own, the persist effect would still see the *previous* member's tab
   * alongside the *new* profile id and write one member's choice under the other's key.
   */
  const [active, setActive] = useState<{ owner: number | null; list: string }>(() => ({
    owner: profileId,
    list: getActiveList(profileId) ?? 'all',
  }))
  const activeList = active.list
  const setActiveList = useCallback((list: string) => setActive((a) => ({ ...a, list })), [])

  // Re-read when the profile changes: each member has their own remembered tab, and switching
  // profiles without this would leave the previous person's choice on screen.
  useEffect(() => {
    setActive({ owner: profileId, list: getActiveList(profileId) ?? 'all' })
  }, [profileId])

  useEffect(() => {
    // Don't write back the placeholder chosen while tasks are still loading — that is precisely
    // the value that would overwrite the remembered one.
    if (loading) return
    // Nor a tab that still belongs to whoever was signed in a moment ago.
    if (active.owner !== profileId) return
    setStoredActiveList(profileId, active.list)
  }, [profileId, active, loading])

  // Keep the active tab valid as tabs appear/disappear (prefs, due-dates, lists).
  //
  // Deliberately inert while tasks are loading. `listNames` is derived from the tasks, so during the
  // first fetch it is empty and every remembered list tab looks invalid — this guard would "correct"
  // it to All and persist that, destroying the preference a moment before the lists that justify it
  // arrive. That race is why the tab appeared not to survive signing back in.
  useEffect(() => {
    if (loading) return
    const available = [...(showTodayTab ? ['today'] : []), ...(showAllTab ? ['all'] : []), ...listNames]
    if (available.length > 0 && !available.includes(activeList)) setActiveList(available[0])
  }, [activeList, showTodayTab, showAllTab, listNames, loading, setActiveList])

  const [draft, setDraft] = useState('')
  const [showCompleted, setShowCompleted] = useState(false)
  // CLEAR affordance on the Completed group: first tap arms the terracotta confirm (TODO_SCREEN.md §3).
  const [clearing, setClearing] = useState(false)
  // Add-a-task target list override (the TO <list> ▾ chip on All/Today); null = first list.
  const [targetOverride, setTargetOverride] = useState<string | null>(null)
  const [picking, setPicking] = useState(false)

  const open = myTasks.filter((t) => !t.completed)
  const done = myTasks.filter((t) => t.completed)
  const onList = activeList !== 'all' && activeList !== 'today'
  const completedVisible = onList ? done.filter((t) => t.listName === activeList) : done

  // Signed in but nothing synced yet → the "choose lists" empty state (spec 03), distinct from
  // an in-filter empty ("nothing to do here").
  const noListsYet = listNames.length === 0 && open.length === 0 && done.length === 0

  // New tasks target the active list; on All/Today, the first list (or the picker override).
  // No implicit "Tasks" default — the spec drops it.
  const targetList = onList
    ? activeList
    : targetOverride && listNames.includes(targetOverride)
      ? targetOverride
      : listNames[0]
  const targetGraphListId = myTasks.find((t) => t.listName === targetList)?.graphListId ?? null

  const toggle = (t: TaskItemDto) => void toggleTask(t)
  // CLEAR removes the completed items in the current tab (never active tasks, never other lists);
  // on All/Today that's every completed item shown. Deletes flow through the write-queue.
  const clearCompleted = () => {
    for (const t of completedVisible) void deleteTask(t)
    setClearing(false)
  }
  // Reset the armed confirm whenever the visible completed set changes (tab switch, sync).
  useEffect(() => setClearing(false), [activeList, completedVisible.length])
  const add = async () => {
    const title = draft.trim()
    if (!title || !activeProfile || !targetList) return
    setDraft('')
    await createTask({ profileId: activeProfile.id, title, note: null, dueUtc: null, listName: targetList, graphListId: targetGraphListId })
  }

  const groups = buildGroups(activeList, open, listNames)

  // Drag-to-scroll + edge fades for the list tabs when they overflow the content width. Declared
  // before the sign-in gate so hooks run unconditionally (rules-of-hooks).
  const tabs = useDragScroll(`${showTodayTab}|${showAllTab}|${listNames.join(',')}`)

  // Identity lives in the global account avatar (spec 13) — the header carries only the title and
  // sync state, with no duplicate name/avatar cluster.
  const header = (
    <header className="ml-header ml-todo__header">
      <span className="ml-todo__title serif">TO DO</span>
      <span className={'ml-todo__sync' + (offline ? ' ml-todo__sync--off' : '')}>
        <span className="ml-todo__syncdot" aria-hidden="true" />
        {offline ? 'Offline' : 'Synced'}
      </span>
    </header>
  )

  // Sign-in gate: unauthenticated never reaches list content (spec 03 §12,44-46).
  if (!activeProfile) {
    return (
      <ScreenShell header={header}>
        <EmptyState label="Not signed in" hint="Sign in from Config to see your lists" />
      </ScreenShell>
    )
  }

  return (
    <ScreenShell header={header}>
      <div
        className={
          'ml-todo__tabswrap' +
          (tabs.edges.start ? ' ml-todo__tabswrap--start' : '') +
          (tabs.edges.end ? ' ml-todo__tabswrap--end' : '')
        }
      >
        <div className="ml-todo__listtabs" role="tablist" ref={tabs.ref} {...tabs.handlers}>
          {showTodayTab && <ListTab label="Today" active={activeList === 'today'} onClick={() => setActiveList('today')} />}
          {showAllTab && <ListTab label="All" active={activeList === 'all'} onClick={() => setActiveList('all')} />}
          {listNames.map((name) => (
            <ListTab key={name} label={name} active={activeList === name} onClick={() => setActiveList(name)} />
          ))}
        </div>
      </div>

      <ScrollArea>
        {open.length === 0 && completedVisible.length === 0 ? (
          noListsYet ? (
            <div className="ml-todo__empty">
              <Icon id="ico-todo" size="2rem" />
              <span>No lists on the panel yet</span>
              <span className="ml-todo__emptyhint">Choose which Microsoft To Do lists sync to this panel.</span>
              <button type="button" className="ml-todo__chooselists" onClick={() => navigate('/settings/lists')}>
                Choose lists
              </button>
            </div>
          ) : (
            <div className="ml-todo__empty">
              <Icon id="ico-todo" size="2rem" />
              <span>Nothing to do here</span>
            </div>
          )
        ) : (
          groups.map((g) => (
            <div className="ml-todo__group" key={g.key}>
              {g.header && (
                <div className="ml-todo__grouphead">
                  <span className="ml-todo__grouplabel">{g.header}</span>
                  <span className="ml-todo__groupcount">{g.tasks.length}</span>
                </div>
              )}
              {g.tasks.map((t) => (
                <TaskRow key={t.id} task={t} onToggle={() => toggle(t)} onStar={() => void setImportant(t, !t.important)} onRename={(title) => void renameTask(t, title)} showList={activeList === 'today'} />
              ))}
            </div>
          ))
        )}

        {completedVisible.length > 0 && (
          <div className="ml-todo__completed">
            <div className="ml-todo__completedhead">
              <button type="button" className="ml-todo__completedtoggle" onClick={() => setShowCompleted((v) => !v)}>
                <span className="ml-todo__completedchev" aria-hidden="true">{showCompleted ? '▾' : '▸'}</span>
                <span className="ml-todo__completedlabel">Completed</span>
                <span className="ml-todo__completedcount">{completedVisible.length}</span>
              </button>
              <button type="button" className="ml-todo__clear" onClick={() => setClearing(true)} aria-label="Clear completed">
                <Icon id="ico-trash" size="0.9375rem" />
                <span>Clear</span>
              </button>
            </div>
            {clearing && (
              <div className="ml-todo__clearconfirm">
                <button type="button" className="ml-todo__clearcancel" onClick={() => setClearing(false)}>Cancel</button>
                <button type="button" className="ml-todo__cleargo" onClick={clearCompleted}>{`Clear ${completedVisible.length} completed`}</button>
              </div>
            )}
            {showCompleted && completedVisible.map((t) => (
              <TaskRow key={t.id} task={t} onToggle={() => toggle(t)} onStar={() => void setImportant(t, !t.important)} onRename={(title) => void renameTask(t, title)} />
            ))}
          </div>
        )}
      </ScrollArea>

      {targetList && (
        <div className="ml-todo__addbar">
          <span className="ml-todo__addplus" aria-hidden="true"><Icon id="ico-add" size="1rem" /></span>
          <input
            className="ml-todo__addfield"
            value={draft}
            placeholder="Add a task"
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && add()}
          />
          {onList || listNames.length <= 1 ? (
            <span className="ml-todo__addtarget">{`To ${targetList}`}</span>
          ) : (
            <div className="ml-todo__addtargetwrap">
              {picking && (
                <div className="ml-todo__targetmenu" role="menu">
                  {listNames.map((name) => (
                    <button
                      key={name}
                      type="button"
                      role="menuitem"
                      className={'ml-todo__targetopt' + (name === targetList ? ' ml-todo__targetopt--active' : '')}
                      onClick={() => { setTargetOverride(name); setPicking(false) }}
                    >
                      {name}
                    </button>
                  ))}
                </div>
              )}
              <button
                type="button"
                className="ml-todo__addtarget ml-todo__addtarget--btn"
                aria-haspopup="menu"
                aria-expanded={picking}
                onClick={() => setPicking((v) => !v)}
              >
                {`To ${targetList}`} <span aria-hidden="true">▾</span>
              </button>
            </div>
          )}
        </div>
      )}
    </ScreenShell>
  )
}

/**
 * Horizontal drag-to-scroll for an overflowing row, plus left/right edge-fade flags. Touch already
 * scrolls a native `overflow-x` region; this adds pointer (mouse) dragging and suppresses the click
 * that ends a drag so it doesn't also select a tab. `depsKey` re-measures when the tab set changes.
 */
function useDragScroll(depsKey: string) {
  const ref = useRef<HTMLDivElement>(null)
  const [edges, setEdges] = useState({ start: false, end: false })
  const drag = useRef({ down: false, x: 0, left: 0, moved: false })

  const update = useCallback(() => {
    const el = ref.current
    if (!el) return
    const max = el.scrollWidth - el.clientWidth
    setEdges({ start: el.scrollLeft > 1, end: el.scrollLeft < max - 1 })
  }, [])

  useEffect(() => {
    const el = ref.current
    if (!el) return
    update()
    el.addEventListener('scroll', update, { passive: true })
    const ro = new ResizeObserver(update)
    ro.observe(el)
    return () => {
      el.removeEventListener('scroll', update)
      ro.disconnect()
    }
  }, [update, depsKey])

  const handlers = {
    onPointerDown: (e: ReactPointerEvent) => {
      const el = ref.current
      if (!el) return
      // Note: no setPointerCapture — capturing the pointer on the strip retargets events so a
      // pointerup on a tab wouldn't fire its click. Bubbling pointermove is enough to drag.
      drag.current = { down: true, x: e.clientX, left: el.scrollLeft, moved: false }
    },
    onPointerMove: (e: ReactPointerEvent) => {
      const el = ref.current
      if (!drag.current.down || !el) return
      const dx = e.clientX - drag.current.x
      if (Math.abs(dx) > 4) drag.current.moved = true
      el.scrollLeft = drag.current.left - dx
    },
    onPointerUp: () => { drag.current.down = false },
    onPointerCancel: () => { drag.current.down = false },
    onClickCapture: (e: ReactMouseEvent) => {
      if (drag.current.moved) {
        e.stopPropagation()
        e.preventDefault()
        drag.current.moved = false
      }
    },
  }

  return { ref, edges, handlers }
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

function TaskRow({ task, onToggle, onStar, onRename, showList }: { task: TaskItemDto; onToggle: () => void; onStar: () => void; onRename: (title: string) => void; showList?: boolean }) {
  const { label, urgency } = dueInfo(task)
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(task.title)
  const inputRef = useRef<HTMLInputElement>(null)

  const beginEdit = () => { setDraft(task.title); setEditing(true) }
  const commit = () => {
    setEditing(false)
    const next = draft.trim()
    if (next && next !== task.title) onRename(next)
  }
  const cancel = () => { setEditing(false); setDraft(task.title) }

  // Focus + select the text when editing opens.
  useEffect(() => {
    if (editing) { const el = inputRef.current; el?.focus(); el?.select() }
  }, [editing])

  return (
    <div className={'ml-todorow' + (task.completed ? ' ml-todorow--done' : '')}>
      <button type="button" className="ml-todorow__check" onClick={onToggle} aria-pressed={task.completed} aria-label="Toggle complete">
        {task.completed && <Icon id="ico-check" size="1rem" />}
      </button>
      <div className="ml-todorow__main">
        {editing ? (
          <input
            ref={inputRef}
            className="ml-todorow__edit"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onBlur={commit}
            onKeyDown={(e) => {
              if (e.key === 'Enter') { e.preventDefault(); commit() }
              else if (e.key === 'Escape') { e.preventDefault(); cancel() }
            }}
            aria-label="Edit task"
          />
        ) : (
          <button type="button" className="ml-todorow__title" onClick={beginEdit} title="Tap to edit">
            {task.title}
          </button>
        )}
        {!editing && (label || (showList && task.listName)) && (
          <div className="ml-todorow__meta">
            {label && <span className={'ml-todorow__due ml-todorow__due--' + urgency}>{label}</span>}
            {showList && task.listName && <span className="ml-todorow__listtag">{task.listName}</span>}
          </div>
        )}
      </div>
      <button
        type="button"
        className={'ml-todorow__star' + (task.important ? ' ml-todorow__star--on' : '')}
        onClick={onStar}
        aria-pressed={task.important}
        aria-label={task.important ? 'Remove importance' : 'Mark important'}
      >
        {task.important ? '★' : '☆'}
      </button>
    </div>
  )
}
