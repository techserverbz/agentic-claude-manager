import { useCallback, useEffect, useRef, useState } from 'react'
import { Bot, Check, Pencil, Plus, RefreshCw, Search, Trash2, User, X } from 'lucide-react'
import { api, type MemoryEntry } from '../lib/api'

/**
 * FloorMemory — the shared notebook this floor's agents read and write.
 *
 * Agents save with `memory_save` and find each other's notes with
 * `memory_search`; this is the human's window onto the same store. It is not a
 * log of what the agents did — it is what they chose to write down, which is
 * why an empty panel means nobody has saved anything, not that nothing happened.
 *
 * A note added here is attributed to YOU and reaches every agent through the
 * same search they already use, so it is the way to tell the whole floor
 * something without opening five chats.
 *
 * Scoped by PROJECT because that is the store an agent chat writes to; notes
 * from other chats in the same project therefore appear too, honestly labelled
 * rather than dressed up as this floor's.
 */

function when(ts: string): string {
  const d = new Date(ts)
  if (Number.isNaN(d.getTime())) return ''
  const mins = Math.round((Date.now() - d.getTime()) / 60000)
  if (mins < 1) return 'just now'
  if (mins < 60) return `${mins}m ago`
  if (mins < 60 * 24) return `${Math.round(mins / 60)}h ago`
  return d.toLocaleDateString()
}

export function FloorMemory({
  floorId,
  projectId,
  refreshSignal,
}: {
  floorId: string | null
  /** the project whose store the floor's chats save into; null = no project yet */
  projectId: string | null
  /** bumped by the panel when this tab becomes visible, so it reloads on open */
  refreshSignal: number
}) {
  const [entries, setEntries] = useState<MemoryEntry[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [query, setQuery] = useState('')
  const [adding, setAdding] = useState(false)
  const [draft, setDraft] = useState('')
  const [saveError, setSaveError] = useState<string | null>(null)
  /* the note being edited, and its working text */
  const [editId, setEditId] = useState<string | null>(null)
  const [editText, setEditText] = useState('')
  /* asked once before a note is actually removed */
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null)
  const draftRef = useRef<HTMLTextAreaElement | null>(null)

  const load = useCallback(
    (q: string, signal?: AbortSignal) => {
      if (!floorId || !projectId) return
      setLoading(true)
      setError(null)
      api
        .floorMemory(floorId, projectId, q)
        .then((d) => {
          if (!signal?.aborted) setEntries(d.entries)
        })
        .catch((e) => {
          if (!signal?.aborted) setError(e?.message || 'could not read the shared memory')
        })
        .finally(() => {
          if (!signal?.aborted) setLoading(false)
        })
    },
    [floorId, projectId],
  )

  /* Debounced, because this searches on every keystroke and each one is a disk
     read of the whole store. 250ms is below the threshold where typing feels
     laggy and well above the interval between two keys. */
  useEffect(() => {
    const ac = new AbortController()
    const t = window.setTimeout(() => load(query, ac.signal), query === '' ? 0 : 250)
    return () => {
      window.clearTimeout(t)
      ac.abort()
    }
  }, [load, query, refreshSignal])

  useEffect(() => {
    if (adding) draftRef.current?.focus()
  }, [adding])

  const save = () => {
    const text = draft.trim()
    if (!text || !floorId || !projectId) return
    setSaveError(null)
    api
      .addFloorMemory(floorId, projectId, text)
      .then((entry) => {
        /* Prepended locally rather than re-fetching: the store is append-only
           and this note is newest by construction, so a round-trip would show
           the same list one beat later. */
        setEntries((prev) => (prev === null ? [entry] : [entry, ...prev]))
        setDraft('')
        setAdding(false)
      })
      .catch((e) => setSaveError(e?.message || 'could not save the note'))
  }

  const saveEdit = (id: string) => {
    const text = editText.trim()
    if (!text || !floorId || !projectId) return
    setError(null)
    api
      .editFloorMemory(floorId, projectId, id, text)
      .then((entry) => {
        /* Patched in place rather than re-fetched: an edit does not change the
           note's position, and a refetch under an active search would reorder
           the list out from under whoever is reading it. */
        setEntries((prev) => (prev === null ? prev : prev.map((x) => (x.id === id ? entry : x))))
        setEditId(null)
      })
      .catch((e) => setError(e?.message || 'could not change that note'))
  }

  const removeNote = (id: string) => {
    if (!floorId || !projectId) return
    setError(null)
    api
      .deleteFloorMemory(floorId, projectId, id)
      .then(() => {
        setEntries((prev) => (prev === null ? prev : prev.filter((x) => x.id !== id)))
        setConfirmDelete(null)
      })
      .catch((e) => setError(e?.message || 'could not delete that note'))
  }

  return (
    <section
      aria-label="Floor memory"
      className="flex h-full min-h-0 w-full flex-col bg-midnight"
    >
      <header className="flex shrink-0 flex-wrap items-center gap-2 border-b border-hairline px-4 py-2.5">
        <span className="font-mono text-[10px] uppercase tracking-[0.24em] text-sand">Memory</span>

        <div className="flex min-w-0 flex-1 items-center gap-2 border border-hairline px-2">
          <Search className="h-3 w-3 shrink-0 text-sand-dim" aria-hidden="true" />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search what this floor knows…"
            aria-label="Search the floor's shared memory"
            className="min-w-0 flex-1 bg-transparent py-1.5 font-display text-[12px] text-parchment outline-none placeholder:text-sand-dim"
          />
          {query !== '' && (
            <button
              type="button"
              onClick={() => setQuery('')}
              aria-label="Clear the search"
              className="flex h-5 w-5 shrink-0 cursor-pointer items-center justify-center text-sand-dim transition-colors duration-150 hover:text-brass"
            >
              <X className="h-3 w-3" aria-hidden="true" />
            </button>
          )}
        </div>

        {entries !== null && (
          <span className="font-mono text-[10px] uppercase tracking-[0.18em] text-sand-dim">
            {entries.length} note{entries.length === 1 ? '' : 's'}
          </span>
        )}
        <button
          type="button"
          onClick={() => setAdding((a) => !a)}
          disabled={!projectId}
          title={
            projectId
              ? 'Write a note every agent on this floor will find'
              : 'Open an agent chat first — a note is saved in that chat’s project'
          }
          className="flex h-7 shrink-0 cursor-pointer items-center gap-1 border border-hairline px-2 font-mono text-[9px] uppercase tracking-[0.14em] text-sand transition-colors duration-200 hover:border-brass hover:text-brass disabled:cursor-not-allowed disabled:opacity-40"
        >
          <Plus className="h-3 w-3" aria-hidden="true" />
          Add note
        </button>
        <button
          type="button"
          onClick={() => load(query)}
          aria-label="Reload the memory"
          title="Reload"
          className="flex h-7 w-7 shrink-0 cursor-pointer items-center justify-center border border-hairline text-sand transition-colors duration-200 hover:border-brass hover:text-brass"
        >
          <RefreshCw className={'h-3 w-3 ' + (loading ? 'animate-spin' : '')} aria-hidden="true" />
        </button>
      </header>

      {adding && (
        <div className="shrink-0 border-b border-hairline bg-surface px-4 py-3">
          <textarea
            ref={draftRef}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              /* Enter alone must NOT submit: these are multi-sentence notes and
                 a note cut off at the first line break is worse than none. */
              if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
                e.preventDefault()
                save()
              } else if (e.key === 'Escape') {
                e.preventDefault()
                setAdding(false)
                setSaveError(null)
              }
            }}
            rows={3}
            placeholder="Something every agent on this floor should know — a decision, a convention, a gotcha."
            className="w-full resize-none border border-hairline bg-midnight px-2.5 py-2 font-display text-[13px] leading-relaxed text-parchment outline-none placeholder:text-sand-dim focus:border-brass"
          />
          {saveError !== null && (
            <p className="mt-2 font-display text-[12px] italic text-[#cf6b52]">{saveError}</p>
          )}
          <div className="mt-2 flex items-center justify-between gap-2">
            <span className="font-mono text-[9px] uppercase tracking-[0.14em] text-sand-dim">
              Saved as you · every agent finds it with memory_search
            </span>
            <div className="flex gap-2">
              <button
                type="button"
                onClick={() => {
                  setAdding(false)
                  setSaveError(null)
                }}
                className="cursor-pointer border border-hairline px-3 py-1.5 font-mono text-[9px] uppercase tracking-[0.14em] text-sand transition-colors duration-200 hover:border-brass hover:text-brass"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={save}
                disabled={draft.trim() === ''}
                className="cursor-pointer border border-brass bg-brass/10 px-3 py-1.5 font-mono text-[9px] uppercase tracking-[0.14em] text-brass transition-colors duration-200 hover:bg-brass/20 disabled:cursor-not-allowed disabled:opacity-40"
              >
                Save note
              </button>
            </div>
          </div>
        </div>
      )}

      {!floorId || !projectId ? (
        <p className="px-6 py-8 font-display text-[13px] italic leading-relaxed text-sand">
          Open an agent’s chat first. Shared memory belongs to the project the
          floor’s chats run in, so there is nothing to show until one is running.
        </p>
      ) : error !== null ? (
        <p className="px-6 py-8 font-display text-[13px] italic leading-relaxed text-sand">
          Could not read the shared memory — {error}.
        </p>
      ) : entries === null ? (
        <p className="px-6 py-8 font-display text-[13px] italic text-sand-dim">Loading…</p>
      ) : entries.length === 0 ? (
        <p className="px-6 py-8 font-display text-[13px] italic leading-relaxed text-sand">
          {query !== ''
            ? `Nothing here matches “${query}”.`
            : 'Nothing saved yet. Agents write here with memory_save when they decide something worth keeping — or add the first note yourself.'}
        </p>
      ) : (
        <ul className="no-scrollbar min-h-0 flex-1 list-none overflow-y-auto p-3">
          {entries.map((e) => (
            <li
              key={e.id}
              className="mb-2 border border-hairline bg-surface p-3 last:mb-0"
            >
              <div className="mb-1.5 flex flex-wrap items-center gap-2 font-mono text-[9px] uppercase tracking-[0.14em]">
                {/* WHO WROTE IT. A person icon for you, a bot icon for an agent
                    — so the two are distinguishable at a glance and not only by
                    reading the name. */}
                <span
                  className={
                    'flex items-center gap-1 rounded-full px-2 py-0.5 ' +
                    (e.isHuman
                      ? 'bg-brass/10 text-brass'
                      : e.byAgent
                        ? 'bg-surface-2 text-parchment'
                        : 'bg-surface-2/60 text-sand-dim')
                  }
                  title={
                    e.isHuman
                      ? 'You wrote this'
                      : e.byAgent
                        ? `${e.author} wrote this from its chat`
                        : 'Written by another chat in this project'
                  }
                >
                  {e.isHuman ? (
                    <User className="h-2.5 w-2.5" aria-hidden="true" />
                  ) : (
                    <Bot className="h-2.5 w-2.5" aria-hidden="true" />
                  )}
                  {e.author}
                </span>
                <span className="text-sand-dim">{when(e.ts)}</span>
                {e.editedAt && (
                  <span className="text-sand-dim" title={`Edited ${when(e.editedAt)}`}>
                    · edited
                  </span>
                )}
                {e.tags.map((t) => (
                  <span key={t} className="border border-hairline px-1.5 py-0.5 text-sand-dim">
                    {t}
                  </span>
                ))}
                <span className="flex-1" />
                {/* Edit and delete on every note, an agent's included: this is
                    the human's notebook, and a wrong note the agents keep
                    finding is worse than no note. The AUTHOR is preserved
                    through an edit — who learned the thing is a fact. */}
                {editId !== e.id && (
                  <>
                    <button
                      type="button"
                      onClick={() => {
                        setEditId(e.id)
                        setEditText(e.text)
                        setConfirmDelete(null)
                      }}
                      title="Edit this note"
                      aria-label="Edit this note"
                      className="flex h-5 w-5 shrink-0 cursor-pointer items-center justify-center text-sand-dim transition-colors duration-150 hover:text-brass"
                    >
                      <Pencil className="h-3 w-3" aria-hidden="true" />
                    </button>
                    {confirmDelete === e.id ? (
                      <button
                        type="button"
                        onClick={() => removeNote(e.id)}
                        className="flex shrink-0 cursor-pointer items-center gap-1 border border-brass px-1.5 py-0.5 text-brass transition-colors duration-150"
                      >
                        <Check className="h-3 w-3" aria-hidden="true" />
                        Really
                      </button>
                    ) : (
                      <button
                        type="button"
                        onClick={() => setConfirmDelete(e.id)}
                        title="Delete this note"
                        aria-label="Delete this note"
                        className="flex h-5 w-5 shrink-0 cursor-pointer items-center justify-center text-sand-dim transition-colors duration-150 hover:text-brass"
                      >
                        <Trash2 className="h-3 w-3" aria-hidden="true" />
                      </button>
                    )}
                  </>
                )}
              </div>
              {editId === e.id ? (
                <div className="flex flex-col gap-2">
                  <textarea
                    value={editText}
                    autoFocus
                    onChange={(ev) => setEditText(ev.target.value)}
                    onKeyDown={(ev) => {
                      if (ev.key === 'Enter' && (ev.metaKey || ev.ctrlKey)) {
                        ev.preventDefault()
                        saveEdit(e.id)
                      } else if (ev.key === 'Escape') {
                        ev.preventDefault()
                        setEditId(null)
                      }
                    }}
                    rows={4}
                    className="w-full resize-none border border-brass bg-midnight px-2.5 py-2 font-display text-[13px] leading-relaxed text-parchment outline-none"
                  />
                  <div className="flex items-center gap-2">
                    <span className="flex-1 font-mono text-[9px] uppercase tracking-[0.14em] text-sand-dim">
                      Ctrl+Enter saves
                    </span>
                    <button
                      type="button"
                      onClick={() => setEditId(null)}
                      className="cursor-pointer border border-hairline px-2.5 py-1 font-mono text-[9px] uppercase tracking-[0.14em] text-sand transition-colors duration-200 hover:border-brass hover:text-brass"
                    >
                      Cancel
                    </button>
                    <button
                      type="button"
                      disabled={editText.trim() === ''}
                      onClick={() => saveEdit(e.id)}
                      className="cursor-pointer border border-brass bg-brass/10 px-2.5 py-1 font-mono text-[9px] uppercase tracking-[0.14em] text-brass transition-colors duration-200 disabled:cursor-not-allowed disabled:opacity-40"
                    >
                      Save note
                    </button>
                  </div>
                </div>
              ) : (
                <p className="whitespace-pre-wrap font-display text-[13px] leading-relaxed text-parchment">
                  {e.text}
                </p>
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}
