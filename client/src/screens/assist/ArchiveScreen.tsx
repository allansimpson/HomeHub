import { useCallback, useEffect, useState } from 'react'
import { useNavigate } from 'react-router'
import { ScreenShell } from '../../components/ScreenShell'
import { DrillInHeader } from '../../components/DrillInHeader'
import { EmptyState } from '../../components/EmptyState'
import { api, ApiError } from '../../api/client'
import type { Conversation } from '../../api/types'
import { useAssist } from '../../app/AssistProvider'
import { shortDate } from './assistTime'

/**
 * The archive (ASSIST.md · `1h`).
 *
 * Reached only from the `ARCHIVED CHATS (n)` footer row at the foot of the inbox — there is no tab,
 * no menu and no second way in, which is the point: the archive is where conversations go to stop
 * being in the way, not a place anyone navigates to on purpose.
 *
 * Rows are muted and carry their own `UNARCHIVE` button. **Nothing here is destructive.** Archived
 * chats stay searchable and keep feeding the agent's memory; delete is a separate act, from
 * selection mode, with a warning in front of it.
 *
 * @category Screen
 */
export function ArchiveScreen() {
  const navigate = useNavigate()
  const { agentKey, agent, refresh } = useAssist()

  const [rows, setRows] = useState<Conversation[]>([])
  const [loading, setLoading] = useState(true)

  const load = useCallback(async () => {
    try {
      setRows(await api.getArchivedConversations(agentKey))
    } catch (err) {
      if (!(err instanceof ApiError)) throw err
    } finally {
      setLoading(false)
    }
  }, [agentKey])

  useEffect(() => { void load() }, [load])

  const unarchive = useCallback(
    async (id: number) => {
      // Optimistic — the row is leaving this screen either way, and waiting for the round-trip on a
      // touch panel reads as a button that did not take.
      setRows((prev) => prev.filter((c) => c.id !== id))
      await api.updateConversation(id, { archived: false })
      // The inbox behind this screen has just gained a row.
      await refresh()
    },
    [refresh],
  )

  const agentName = agent?.name ?? 'Assist'
  const count = rows.length

  return (
    <ScreenShell
      header={
        <DrillInHeader
          title="Archive"
          onBack={() => navigate('/assist')}
          status={`${agentName} · ${count} ${count === 1 ? 'chat' : 'chats'}`}
        />
      }
      avatarBadge={false}
    >
      <div className="ml-assist__list">
        {!loading && rows.length === 0 && (
          <EmptyState
            label="Nothing archived"
            hint="Swipe a chat left in Assist to file it here. Archived chats stay searchable."
          />
        )}

        {rows.map((c) => (
          <div key={c.id} className="ml-archiverow">
            <span className="ml-archiverow__main">
              <span className="ml-archiverow__title">{c.title}</span>
              <span className="ml-archiverow__meta">
                {`Archived ${shortDate(c.archivedAtUtc)} · ${c.messageCount} ${c.messageCount === 1 ? 'message' : 'messages'}`}
              </span>
            </span>
            <button
              type="button"
              className="ml-archiverow__action"
              onClick={() => void unarchive(c.id)}
            >
              Unarchive
            </button>
          </div>
        ))}
      </div>
    </ScreenShell>
  )
}
