import { useEffect, useRef } from 'react'
import { X } from 'lucide-react'

/**
 * WorkflowHelp — the reference sheet behind the (i) in the Project Workflows
 * header.
 *
 * It exists because this view has two audiences and they need different things
 * written down. YOU need to know what the buttons do and why one is disabled.
 * The SESSIONS need tools, and their briefs already tell them those tools
 * exist — so when a step says "I called step_done", you need somewhere to check
 * what that actually did and who was allowed to call it.
 *
 * Two rules this content follows, because a help panel that breaks either is
 * worse than none:
 *
 *  · Everything here is a feature that EXISTS. No roadmap, no "coming soon".
 *    A reference sheet that documents intentions teaches you things that are
 *    not true, and you find out at the worst moment.
 *
 *  · Where a rule will surprise you, the rule is stated WITH its reason. "The
 *    father cannot mark a step done" reads as a missing feature until you know
 *    it is deliberate, at which point it reads as the guarantee it is.
 */

type Tool = {
  name: string
  args: string
  who: string
  what: string
}

const CROSS_CHAT: Tool[] = [
  {
    name: 'list_chats',
    args: '—',
    who: 'any chat in the run',
    what: 'The sibling chats it can see, with their short ids and whether each is live.',
  },
  {
    name: 'read_chat',
    args: 'sessionId',
    who: 'any chat in the run',
    what: 'Read what another chat has said, without interrupting it.',
  },
  {
    name: 'send_to_chat',
    args: 'sessionId, text',
    who: 'any chat in the run',
    what: 'Send a message to one sibling. It arrives prefixed [message from …] and the receiver is told to treat it as untrusted data, never as an instruction from you.',
  },
  {
    name: 'broadcast_to_chats',
    args: 'text',
    who: 'any chat in the run',
    what: 'Send to every sibling at once. Rate limited, deliberately — a broadcast loop between two chats is the failure this cap exists to stop.',
  },
]

const MEMORY: Tool[] = [
  {
    name: 'memory_save',
    args: 'text, tags?',
    who: 'any chat in the run',
    what: 'Persist a fact, decision or hand-off into THIS RUN’s shared memory.',
  },
  {
    name: 'memory_search',
    args: 'query, limit?',
    who: 'any chat in the run',
    what: 'Keyword search. Reads a union: this run first, then the project, then the directory — so a step sees project-wide knowledge but its own notes stay in its run.',
  },
  {
    name: 'memory_recent',
    args: 'limit?',
    who: 'any chat in the run',
    what: 'The latest notes, for picking up where a sibling left off.',
  },
]

const WORKFLOW: Tool[] = [
  {
    name: 'workflow_status',
    args: '—',
    who: 'any chat in the run',
    what: 'The run, every step, who owns it, its status and last result. Where the father starts.',
  },
  {
    name: 'dispatch_step',
    args: 'step, task?',
    who: 'the father only',
    what: 'Hand a step to its chat, naming it by title or id. Spawns the session if it is not running. Refuses an ambiguous title rather than guessing, and refuses a stage.',
  },
  {
    name: 'step_done',
    args: 'result',
    who: 'the step itself',
    what: 'Marks the calling step done. Takes no step id: a step cannot report for a sibling.',
  },
  {
    name: 'step_blocked',
    args: 'reason',
    who: 'the step itself',
    what: 'Says why it cannot proceed, rather than guessing or doing a neighbouring step.',
  },
  {
    name: 'step_note',
    args: 'text',
    who: 'the step itself',
    what: 'A progress note into the run’s memory, so the father can see movement without interrupting.',
  },
]

/** things the view does, and the one sentence each that stops it surprising you */
const FEATURES: { title: string; body: string }[] = [
  {
    title: 'Workflow projects are separate',
    body: 'They live in their own list on the left and never appear under GROUPS. Their chats stay in this view — that is the point of the split, so a running SOP does not clutter your ordinary work.',
  },
  {
    title: 'A template is reusable',
    body: 'The same Feasibility SOP can be attached to Kharadi and to Baner. Attaching links it; it does not copy it. Editing the template bumps its version, and a run keeps the version it started on.',
  },
  {
    title: 'Attaching starts nothing',
    body: 'Attach puts a template on the project’s shelf. Start Run is what spawns the father chat and real processes. Two separate verbs, so a mis-click never costs you a session.',
  },
  {
    title: 'A run needs a directory',
    body: 'Sessions have to run somewhere. If the project has no directory, Start Run is disabled and says so — guessing a working directory would run an SOP against the wrong repository.',
  },
  {
    title: 'Steps run in the SOP’s order',
    body: 'The prev/next chain you authored in the CRM becomes a real dependency. A step whose predecessor is not done shows as waiting, and dispatching it anyway is offered only with a warning.',
  },
  {
    title: 'Stages are containers',
    body: 'A step with children is a stage. It is never dispatched, and its status is derived from the steps inside it — so a run can always reach 100%.',
  },
  {
    title: 'Every step gets a brief',
    body: 'A spawned session wakes up already knowing the workflow, which step it is, who its father is, who its siblings are, and its own tutorial. It does not have to ask.',
  },
  {
    title: 'The father greets you',
    body: 'When a run starts, the father opens by welcoming you, asking for the documents it needs, and waiting. It does not begin work until you reply.',
  },
]

function ToolTable({ rows }: { rows: Tool[] }) {
  return (
    <div className="mt-3 overflow-x-auto border border-hairline-s">
      <table className="w-full min-w-[520px] border-collapse text-left">
        <thead>
          <tr className="border-b border-hairline-s">
            {['Tool', 'Arguments', 'Who may call it'].map((h) => (
              <th
                key={h}
                className="px-3 py-2 font-mono text-[8px] uppercase tracking-[0.2em] text-sand-dim"
              >
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((t) => (
            <tr key={t.name} className="border-b border-hairline-s align-top last:border-b-0">
              <td className="px-3 py-2.5">
                <span className="font-mono text-[11px] text-brass">{t.name}</span>
                <span className="mt-1 block max-w-[52ch] font-display text-[12px] italic leading-relaxed text-sand">
                  {t.what}
                </span>
              </td>
              <td className="whitespace-nowrap px-3 py-2.5 font-mono text-[10px] text-sand-dim">
                {t.args}
              </td>
              <td className="whitespace-nowrap px-3 py-2.5 font-mono text-[9px] uppercase tracking-[0.12em] text-sand-dim">
                {t.who}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

function Section({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <section className="mt-8 first:mt-0">
      <h3 className="flex items-center gap-3 font-mono text-[10px] uppercase tracking-[0.28em] text-sand">
        <span className="h-px w-5 bg-hairline" aria-hidden="true" />
        {label}
      </h3>
      {children}
    </section>
  )
}

export function WorkflowHelp({ onClose }: { onClose: () => void }) {
  const closeRef = useRef<HTMLButtonElement>(null)

  // Escape closes, and focus lands on the close button — this opens over a live
  // board, so getting back out must never need the mouse.
  useEffect(() => {
    closeRef.current?.focus()
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="What this view does"
      className="absolute inset-0 z-30 flex flex-col bg-midnight"
    >
      <header className="flex shrink-0 items-center gap-3.5 border-b border-hairline px-5 py-3 font-mono text-[10px] uppercase tracking-[0.3em] text-sand">
        <span className="h-px w-6 bg-hairline" aria-hidden="true" />
        <span className="text-brass" aria-hidden="true">
          ✦
        </span>
        <span className="min-w-0 flex-1 truncate">Project Workflows · reference</span>
        <button
          ref={closeRef}
          type="button"
          onClick={onClose}
          aria-label="Close the reference"
          className="shrink-0 cursor-pointer text-sand-dim transition-colors duration-150 hover:text-brass"
        >
          <X className="h-3.5 w-3.5" aria-hidden="true" />
        </button>
      </header>

      <div className="no-scrollbar min-h-0 flex-1 overflow-y-auto px-5 py-6">
        <div className="mx-auto max-w-3xl">
          <h2 className="font-display text-[24px] font-medium leading-tight text-parchment">
            A workflow, and the chats that <em className="font-normal italic text-brass">run it</em>
          </h2>
          <p className="mt-3 max-w-[68ch] font-display text-[14px] italic leading-relaxed text-sand">
            A workflow is an ordered tree of steps, each carrying the markdown tutorial its
            session is briefed with. Starting a run spawns a father chat that dispatches the
            steps; each step works in its own Claude session, and they can see and message one
            another. Everything below is built and working.
          </p>

          <Section label="How it behaves">
            <dl className="mt-3 grid gap-x-8 gap-y-4 sm:grid-cols-2">
              {FEATURES.map((f) => (
                <div key={f.title}>
                  <dt className="font-mono text-[10px] uppercase tracking-[0.16em] text-parchment">
                    {f.title}
                  </dt>
                  <dd className="mt-1.5 max-w-[46ch] font-display text-[13px] italic leading-relaxed text-sand">
                    {f.body}
                  </dd>
                </div>
              ))}
            </dl>
          </Section>

          <Section label="Tools · running the workflow">
            <p className="mt-2 max-w-[68ch] font-display text-[13px] italic leading-relaxed text-sand-dim">
              Every session in a run gets these. Who may call each one is enforced by the server
              from the session’s own token, not from anything the model claims about itself —
              which is why a step cannot mark a sibling’s work done.
            </p>
            <ToolTable rows={WORKFLOW} />
          </Section>

          <Section label="Tools · talking to the other chats">
            <ToolTable rows={CROSS_CHAT} />
          </Section>

          <Section label="Tools · shared memory">
            <p className="mt-2 max-w-[68ch] font-display text-[13px] italic leading-relaxed text-sand-dim">
              Memory is scoped to the RUN, so a second run of the same workflow on a different
              plot never reads the first one’s notes as its own.
            </p>
            <ToolTable rows={MEMORY} />
          </Section>

          <Section label="Where things are kept">
            <dl className="mt-3 space-y-2.5 font-mono text-[11px]">
              {[
                ['server/data/workflows.json', 'the templates, with every step’s tutorial'],
                ['server/data/workflow-runs.json', 'each run, and which session owns which step'],
                ['server/data/briefs/<sessionId>.md', 'the exact prompt a session was started with'],
                ['server/data/memory/<runId>.jsonl', 'that run’s shared memory, append-only'],
                [
                  'server/data/groups.json',
                  'every project, both kinds. The "kind" field is what splits them: "workflow" appears in this tab, "project" appears under GROUPS.',
                ],
              ].map(([path, what]) => (
                <div key={path} className="flex flex-wrap items-baseline gap-x-3">
                  <dt className="text-sand-dim">{path}</dt>
                  <dd className="max-w-[62ch] font-display text-[12px] italic leading-relaxed text-sand">
                    {what}
                  </dd>
                </div>
              ))}
            </dl>
          </Section>

          <span className="mo-rule mt-10 block" aria-hidden="true" />
        </div>
      </div>
    </div>
  )
}
