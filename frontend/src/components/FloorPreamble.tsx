import { useEffect, useRef, useState } from 'react'
import { FolderTree } from 'lucide-react'
import type { Floor, Project } from '../lib/api'
import { FloorWorkspace } from './FloorWorkspace'

/**
 * FloorPreamble — the one thing every agent on a floor is told first.
 *
 * It exists because an agent's brief says who it is, and nothing said WHERE the
 * work is. A CRM agent started in the orchestrator's own directory reads the
 * orchestrator's source and answers confidently about the wrong codebase — not
 * a reasoning failure, a briefing one. So this is a floor-level field rather
 * than something retyped into seven agent briefs, because it is one fact about
 * the floor and it must not be able to disagree with itself.
 *
 * It rides in two places, deliberately:
 *
 *  · in the system prompt of every chat this floor spawns, above the agent's
 *    own brief — the standing answer to "which codebase am I in";
 *  · flattened to one line in front of every instruction the board hands out —
 *    because a chat that was already running when this was written never saw
 *    the brief, and one line settles it every time.
 *
 * Saving is on a delay rather than a button. This is a text field somebody
 * pastes a path into and then leaves; a Save button is one more thing to
 * forget, and this text is worth nothing if it is not saved.
 */

const SAVE_AFTER_MS = 700
/** matches the server's cap (floors.js GLOBAL_PROMPT_MAX) */
const MAX = 8000

export function FloorPreamble({
  floor,
  projects,
  onSave,
  onWorkspaceChanged,
}: {
  floor: Floor | null
  projects: Project[]
  /** the floor gained or moved its workspace — refetch floors and projects */
  onWorkspaceChanged: () => void
  /** persist the floor's preamble; resolves when the server has it */
  onSave: (floorId: string, globalPrompt: string) => Promise<void>
}) {
  const [text, setText] = useState(floor?.globalPrompt ?? '')
  const [state, setState] = useState<'clean' | 'typing' | 'saving' | 'saved' | 'failed'>('clean')

  /* Re-seed when the FLOOR changes, never on every prop change: the parent
     re-renders on each keystroke's optimistic update, and re-seeding from the
     prop there would fight the cursor. */
  const seededFor = useRef<string | null>(null)
  useEffect(() => {
    if (floor === null || seededFor.current === floor.id) return
    seededFor.current = floor.id
    setText(floor.globalPrompt ?? '')
    setState('clean')
  }, [floor])

  /* Latest values without putting them in the timer's deps — a dep on `text`
     would tear down and rebuild the timer on every keystroke, which is the same
     debounce written the hard way, and a dep on `onSave` (an inline arrow from
     the panel) would rebuild it on every render of the parent. */
  const textRef = useRef(text)
  textRef.current = text
  const onSaveRef = useRef(onSave)
  onSaveRef.current = onSave

  useEffect(() => {
    if (state !== 'typing' || floor === null) return
    const id = floor.id
    const timer = window.setTimeout(() => {
      const value = textRef.current
      setState('saving')
      void onSaveRef
        .current(id, value)
        .then(() => setState((s) => (s === 'saving' ? 'saved' : s)))
        .catch(() => setState('failed'))
    }, SAVE_AFTER_MS)
    return () => window.clearTimeout(timer)
  }, [state, floor])

  if (floor === null) {
    return (
      <div className="flex h-full items-center justify-center px-8 text-center">
        <p className="max-w-md font-display text-[14px] italic leading-relaxed text-sand">
          Pick a floor to write its preamble.
        </p>
      </div>
    )
  }

  const note =
    state === 'saving'
      ? 'Saving…'
      : state === 'saved'
        ? 'Saved — new chats get it in their brief, running ones get it with their next instruction.'
        : state === 'failed'
          ? 'Could not save. Your text is still here — try again.'
          : state === 'typing'
            ? 'Unsaved'
            : `${text.length.toLocaleString()} / ${MAX.toLocaleString()} characters`

  return (
    <div className="no-scrollbar flex h-full min-h-0 flex-col overflow-y-auto">
      {/* The folder first, the words second: a preamble naming a directory
          the agents do not actually run in is the failure this pair exists
          to prevent. */}
      <FloorWorkspace floor={floor} projects={projects} onChanged={onWorkspaceChanged} />

      <div className="flex shrink-0 items-baseline gap-3 border-b border-hairline px-5 py-3">
        <span className="font-mono text-[10px] uppercase tracking-[0.22em] text-sand-dim">
          Preamble
        </span>
        <span className="min-w-0 flex-1 font-display text-[13px] italic text-sand">
          Every agent on {floor.name} is told this before anything else — say which codebase they
          are working in.
        </span>
      </div>

      <div className="min-h-[16rem] flex-1 px-5 py-4">
        <textarea
          value={text}
          spellCheck={false}
          maxLength={MAX}
          onChange={(e) => {
            setText(e.target.value)
            setState('typing')
          }}
          placeholder={
            'We work in C:\\Users\\you\\Desktop\\Github\\28.SCRM\\1.4 AIO CRM — that directory is the codebase, ' +
            'not the app you are running inside. Read and change files there only.'
          }
          className="h-full w-full resize-none border border-hairline bg-midnight px-4 py-3 font-mono text-[12px] leading-relaxed text-parchment outline-none transition-colors duration-200 placeholder:text-sand-dim/60 focus:border-brass"
        />
      </div>

      <div className="flex shrink-0 items-center gap-2 border-t border-hairline px-5 py-2.5">
        <FolderTree className="h-3 w-3 shrink-0 text-sand-dim" aria-hidden="true" />
        <p
          aria-live="polite"
          className={`font-mono text-[9.5px] uppercase tracking-[0.16em] ${
            state === 'failed' ? 'text-[#cf6b52]' : 'text-sand-dim'
          }`}
        >
          {note}
        </p>
      </div>
    </div>
  )
}
