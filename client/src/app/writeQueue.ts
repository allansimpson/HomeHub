/**
 * Offline write-queue (Stage 9b). User mutations that can't reach the server are persisted here
 * (localStorage, survives reload) and replayed in order on reconnect. Conditional writes carry the
 * version last seen so the server can 409 an edit-vs-edit conflict, which we surface rather than
 * silently overwrite (conservative policy). Climate set-points carry no version (last-write-wins).
 */

export type WriteDomain = 'task' | 'calendar' | 'climate'

export interface QueuedOp {
  id: string
  domain: WriteDomain
  method: 'POST' | 'PUT' | 'PATCH' | 'DELETE'
  /** Path under /api, e.g. "/tasks/5/complete". */
  path: string
  body?: unknown
  /** Optimistic-concurrency token sent as ?baseVersion=; omitted → last-write-wins. */
  baseVersion?: number
  /** Human-readable description for the pending/conflict UI. */
  label: string
  createdAt: number
}

export type ExecOutcome =
  | { kind: 'ok'; data: unknown }
  | { kind: 'conflict'; current: unknown }
  | { kind: 'gone' }
  | { kind: 'offline' }
  | { kind: 'error'; status: number; message: string }

const KEY = 'homehub.writequeue.v1'

export function loadQueue(): QueuedOp[] {
  try {
    const raw = localStorage.getItem(KEY)
    return raw ? (JSON.parse(raw) as QueuedOp[]) : []
  } catch {
    return []
  }
}

export function saveQueue(ops: QueuedOp[]): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(ops))
  } catch {
    /* storage full / unavailable — best effort */
  }
}

export function newId(): string {
  const c = globalThis.crypto as { randomUUID?: () => string } | undefined
  if (c?.randomUUID) return c.randomUUID()
  return `op-${Date.now()}-${Math.floor(Math.random() * 1e9)}`
}

/** Execute one queued op against the API. `forceOverwrite` drops the version check (keep-mine). */
export async function executeOp(op: QueuedOp, forceOverwrite = false): Promise<ExecOutcome> {
  const useVersion = !forceOverwrite && op.baseVersion != null
  const sep = op.path.includes('?') ? '&' : '?'
  const url = `/api${op.path}${useVersion ? `${sep}baseVersion=${op.baseVersion}` : ''}`

  let res: Response
  try {
    res = await fetch(url, {
      method: op.method,
      headers: op.body != null ? { 'Content-Type': 'application/json' } : undefined,
      body: op.body != null ? JSON.stringify(op.body) : undefined,
      cache: 'no-store',
    })
  } catch {
    return { kind: 'offline' }
  }

  if (res.ok) {
    const text = await res.text().catch(() => '')
    return { kind: 'ok', data: text ? JSON.parse(text) : undefined }
  }
  if (res.status === 409) {
    const current = await res.json().catch(() => undefined)
    return { kind: 'conflict', current }
  }
  if (res.status === 404) return { kind: 'gone' }
  return { kind: 'error', status: res.status, message: res.statusText }
}
