/*
 * The MCP tool catalogue — the ONE declaration.
 *
 * Both the stdio shim (which serves these to claude) and the HTTP API (which
 * shows them in the app) read this file. It used to live only inside the shim,
 * which cannot be imported by the server: it attaches a stdin reader at module
 * load, so importing it would hijack the server process stdin.
 */

export const TOOLS = [
  {
    name: 'list_chats',
    description:
      'List the OTHER live Claude chats (sibling terminals/windows) running in this same Christopher OS project right now. Use this first whenever the user refers to "the other chat", "the other window", "my other terminal", or you need to coordinate work across chats. Returns each sibling\'s sessionId and title.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'floor_roster',
    description:
      'The roster of YOUR floor: every agent on it, and whether each one is online (its chat is running), offline (opened before, not running now), or never opened. Use this — not list_chats — to answer "how many agents do I have" or "who is on my floor": list_chats only sees chats that are live right now, so an agent nobody has opened is invisible to it. Returns totals plus a row per agent.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'read_chat',
    description:
      'Read the recent live terminal output of a sibling Claude chat in this project (what that chat is doing/saying right now). Use after list_chats to check on another chat\'s progress or see what the user discussed there. Returns the last N lines, ANSI-stripped.',
    inputSchema: {
      type: 'object',
      properties: {
        sessionId: { type: 'string', description: 'The sibling session id from list_chats (use "new" for an unsaved fresh session).' },
        lines: { type: 'number', description: 'How many trailing lines to read (default 100, max 500).' },
      },
      required: ['sessionId'],
      additionalProperties: false,
    },
  },
  {
    name: 'send_to_chat',
    description:
      'Type a message into a sibling Claude chat\'s terminal and submit it — the sibling chat will receive it as user input and respond. Use to delegate a task to or ask a question of another chat. Never target your own session, and do not tell the receiving chat to broadcast (that creates loops).',
    inputSchema: {
      type: 'object',
      properties: {
        sessionId: { type: 'string', description: 'The sibling session id from list_chats.' },
        text: { type: 'string', description: 'The message/prompt to send to that chat.' },
      },
      required: ['sessionId', 'text'],
      additionalProperties: false,
    },
  },
  {
    name: 'broadcast_to_chats',
    description:
      'Send one message to EVERY live sibling chat in this project at once (each receives it as user input). Use sparingly — e.g. "stop current work", or announcing a decision all chats must know. Never instruct recipients to broadcast back (loop risk).',
    inputSchema: {
      type: 'object',
      properties: {
        text: { type: 'string', description: 'The message to send to all sibling chats.' },
      },
      required: ['text'],
      additionalProperties: false,
    },
  },
  {
    name: 'memory_save',
    description:
      'Save a note to SHARED MEMORY — persisted knowledge that sibling chats, now and later, can search. Save decisions, conventions, gotchas, task hand-offs, and anything the user says to "remember". Where it lands depends on what this chat is: in an ordinary project chat it goes to the project\'s memory, which every chat in the project can read; inside a workflow run it goes to THAT RUN\'s memory, read by your siblings and the father and by no other run. There is no way to write past your own run into the project store, so if something must outlive this run, tell the human as well. Keep each note self-contained.',
    inputSchema: {
      type: 'object',
      properties: {
        text: { type: 'string', description: 'The fact/decision/note to persist (self-contained, 1-4 sentences).' },
        tags: { type: 'array', items: { type: 'string' }, description: 'Optional lowercase topic tags (e.g. ["auth","decision"]).' },
      },
      required: ['text'],
      additionalProperties: false,
    },
  },
  {
    name: 'memory_search',
    description:
      'Search SHARED MEMORY — notes saved by any sibling chat, past or present. Inside a workflow run this reads your run\'s notes AND the wider project\'s, so you inherit what the project already knows; other runs of the same workflow are never included. Use before starting work on a topic, and whenever the user asks "did we decide/discuss X" or context from another chat might exist.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Keywords to search for.' },
        limit: { type: 'number', description: 'Max results (default 10).' },
      },
      required: ['query'],
      additionalProperties: false,
    },
  },
  {
    name: 'workflow_status',
    description:
      'Show the workflow RUN this chat belongs to: every step, its status, which chat owns it, whether that chat is running, and its last result or blocked reason. If you are the father of a run, call this FIRST in any turn about the workflow and again before dispatching, so you act on the real board rather than on memory. If you are one of the steps, call it to see whether the step you depend on has finished, or who to ask. Says so plainly if this chat is not part of a run.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'dispatch_step',
    description:
      'Hand one step of this workflow run to its own Claude chat, starting that chat if it is not running yet. FATHER ONLY — a step cannot dispatch its siblings. Call it when a step is genuinely ready: nothing it waits on is outstanding, and you have whatever the human had to supply. Dispatch what is ready rather than everything at once, and check the result of a step before dispatching what depended on it. Name the step by its title or its id from workflow_status; an ambiguous title is refused with the candidates rather than guessed, and a step that is already working or already done is refused.',
    inputSchema: {
      type: 'object',
      properties: {
        step: { type: 'string', description: 'The step title, or its id from workflow_status.' },
        task: {
          type: 'string',
          description:
            'Optional extra instruction typed into that chat on top of the tutorial it is already briefed with — the specific plot, the file to start from, what the human just told you. One paragraph.',
        },
      },
      required: ['step'],
      additionalProperties: false,
    },
  },
  {
    name: 'step_done',
    description:
      'Report YOUR OWN step of this workflow run finished, with a short result. Call it the moment your work is done — it moves the step to REVIEW on the board the human and the father are watching, and unblocks whatever was waiting on you. It does NOT mark the step done: a person accepts it, which is what keeps "done" meaning someone looked at the work. Ending your turn without calling this leaves the run looking stalled. It always reports the step THIS chat was dispatched for; there is no way to report for a sibling, so do not try.',
    inputSchema: {
      type: 'object',
      properties: {
        result: {
          type: 'string',
          description: 'One short paragraph: what you produced, and where it is (path, sheet, url).',
        },
      },
      required: ['result'],
      additionalProperties: false,
    },
  },
  {
    name: 'step_blocked',
    description:
      'Mark YOUR OWN step of this workflow run blocked, with the reason. Call it instead of guessing, inventing data, or doing a neighbouring step, whenever something you need is missing or the decision is above your pay grade. The father reads the reason on the board and either unblocks you or re-dispatches the step, so this is not the end of your step. Like step_done it can only ever touch this chat\'s own step.',
    inputSchema: {
      type: 'object',
      properties: {
        reason: { type: 'string', description: 'What stopped you, and what would unblock it.' },
      },
      required: ['reason'],
      additionalProperties: false,
    },
  },
  {
    name: 'step_note',
    description:
      'Save a progress note to THIS RUN\'s shared memory — visible to your siblings and to the father, and to no other run. Use it mid-step, before you are finished, for anything worth knowing now: a number you established, a file you produced, an assumption you had to make. It lets the father see movement without interrupting you, and stops a sibling redoing your work. memory_save writes to the same run store from inside a run; the difference is only what the note is for — step_note is movement on your step, memory_save is a decision or fact worth keeping.',
    inputSchema: {
      type: 'object',
      properties: {
        text: { type: 'string', description: 'The progress note (self-contained, 1-3 sentences).' },
      },
      required: ['text'],
      additionalProperties: false,
    },
  },
  {
    name: 'memory_recent',
    description:
      'List the most recent entries in SHARED MEMORY — what your sibling chats have learned/decided lately. Inside a workflow run this covers your run\'s notes and the wider project\'s, and no other run. Useful at the start of a task to pick up where sibling chats left off.',
    inputSchema: {
      type: 'object',
      properties: {
        limit: { type: 'number', description: 'Max entries (default 10).' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'floor_board',
    description:
      'Read the KANBAN BOARD your floor is attached to — the live CRM goals for its project, product/service, or "my tasks", in the columns to do / in progress / review / done, plus the roster of agents you can give them to. Call this FIRST in any turn about work, and again before assigning, so you act on the real board rather than on memory: the human edits it in the app and other agents move cards on it while you are talking. Says so plainly if your floor is not attached to anything yet.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'goal_add',
    description:
      'Put a NEW GOAL on your floor\'s board — a real, live goal in the CRM, visible to everyone in the company, not a private note. BOSS ONLY. This is how anything the human says in this chat becomes tracked work: when they describe something to be done, write it down here rather than only answering. One goal per distinct piece of work, titled the way a person would read it on a board ("Fix the CSRF cookie on staging", not "task 1"). The scope is your floor\'s own — you cannot write onto another project\'s board and do not need to say which. Goals land in "to do" unless you say otherwise; assign one with goal_assign afterwards.',
    inputSchema: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'What is to be done, as a person would read it on a board.' },
        description: { type: 'string', description: 'Optional detail: acceptance criteria, links, the context the doer will need.' },
        priority: {
          type: 'string',
          enum: ['low', 'medium', 'high', 'urgent'],
          description: 'Default medium. Reserve urgent for what the human called urgent.',
        },
        status: {
          type: 'string',
          enum: ['todo', 'in-progress', 'review', 'done'],
          description: 'Default todo. Only pass something else to record work that already happened.',
        },
        dueDate: { type: 'string', description: 'Optional ISO date (YYYY-MM-DD).' },
      },
      required: ['title'],
      additionalProperties: false,
    },
  },
  {
    name: 'agent_hire',
    description:
      'Create a NEW AGENT on your floor, reporting to you. BOSS ONLY. Use it when the work in front of you needs an owner that does not exist yet — a reviewer, a migration specialist, somebody to own one subsystem. The `md` you write IS that agent\'s brief: it is what the agent is told about itself when its chat starts, so write what it owns, what it must not touch, and how it should report back. Hire deliberately, one at a time, for work you are about to give it — a floor of idle agents is worse than a small one, and every agent is a real claude process once it is assigned something. Names must be unique on the floor, because assigning work addresses an agent by name.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Unique on this floor. A person\'s name or a role name, e.g. "Pam" or "Migration".' },
        role: { type: 'string', description: 'Short title shown under the name on the floor, e.g. "Reviewer".' },
        md: { type: 'string', description: 'The agent\'s brief in markdown — what it owns, its boundaries, how to report back. This becomes its system prompt.' },
        reportsTo: { type: 'string', description: 'Name of the agent it reports to. Defaults to you.' },
        model: { type: 'string', enum: ['opus', 'sonnet', 'haiku'], description: 'Optional model to pin it to. Omit to inherit.' },
      },
      required: ['name'],
      additionalProperties: false,
    },
  },
  {
    name: 'goal_assign',
    description:
      'Hand ONE goal from your floor\'s board to ONE of your agents, starting that agent\'s chat if it is not running. BOSS ONLY. This does three things at once: it starts or wakes the agent, types the goal into its chat as an instruction from you, and moves the card to IN PROGRESS on the CRM board the human is watching. Assign what is genuinely ready and one thing at a time — an agent working two goals reports on neither. Name the goal by its title (a substring is enough) or its id from floor_board; an ambiguous title is refused with the candidates rather than guessed. After assigning, the agent works in its own chat: use read_chat on the session id it returns to look in on it, and move the card to review yourself when you have seen the work.',
    inputSchema: {
      type: 'object',
      properties: {
        goal: { type: 'string', description: 'The goal\'s title (substring is enough) or its id from floor_board.' },
        agent: { type: 'string', description: 'The agent\'s name, exactly as floor_board lists it.' },
        task: {
          type: 'string',
          description:
            'Optional extra instruction on top of the goal itself — the file to start from, the constraint the human just gave, what "done" means here. One paragraph.',
        },
      },
      required: ['goal', 'agent'],
      additionalProperties: false,
    },
  },
  {
    name: 'prompt_board',
    description:
      'Read the PROMPT KANBAN — the queue of work the human has written down for this floor, in the columns to do / in progress / review / done. This is NOT the goal board: floor_board is the company\'s live CRM goals, this is the human talking to you and your agents. It exists so they can write every prompt at once instead of waiting for one to finish before giving the next, and your job is to work that queue down. Read it at the start of any turn about what to do next, and whenever the human says "what is pending" or "carry on". Any agent on the floor may read it; only the boss hands cards out.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'prompt_assign',
    description:
      'Hand ONE card from the prompt board to ONE of your agents, starting that agent\'s chat if it is not running. BOSS ONLY. This is what makes several prompts run at once: it starts or wakes the agent, types the prompt into its chat as an instruction from you, and moves the card to in progress. Give one card to one agent at a time. Name the card by its id from prompt_board or by words from its text; an ambiguous match is refused with the candidates rather than guessed, and a card already in progress is refused. Afterwards the agent works in its own chat — read_chat on the session id it returns to look in on it, and move the card yourself with prompt_status when you have seen the work.',
    inputSchema: {
      type: 'object',
      properties: {
        prompt: { type: 'string', description: 'The card\'s id from prompt_board, or distinctive words from its text.' },
        agent: { type: 'string', description: 'The agent\'s name, exactly as prompt_board lists it.' },
        task: {
          type: 'string',
          description: 'Optional extra instruction on top of the prompt itself — the file to start from, what "done" means here. One paragraph.',
        },
      },
      required: ['prompt', 'agent'],
      additionalProperties: false,
    },
  },
  {
    name: 'prompt_add',
    description:
      'Put a NEW card on the prompt board. BOSS ONLY. Use it when one thing the human asked for is really several pieces of work: write each piece as its own card so they can be handed out in parallel and tracked separately. Cards you add are marked as written by you, so the human can tell their own backlog from your decomposition of it. Do NOT copy the human\'s prompt back onto the board — it is already there.',
    inputSchema: {
      type: 'object',
      properties: {
        text: { type: 'string', description: 'The prompt, written so an agent could act on it without seeing this chat.' },
        priority: { type: 'string', enum: ['low', 'medium', 'high', 'urgent'], description: 'Default medium.' },
      },
      required: ['text'],
      additionalProperties: false,
    },
  },
  {
    name: 'prompt_ask',
    description:
      'Mark the card YOU are working on as waiting on the human, and write down what you need to know. Any agent may call it — it finds your card by this chat, so you can only ever stall your own work. Use it the moment you hit a decision that is genuinely the humans to make, instead of guessing and building the wrong thing, and then stop. It is the human who has to decide. WHY THIS AND NOT JUST ASKING IN THE CHAT: a question typed into a terminal exists only in that terminal. When the app restarts every session dies and the question goes with it, leaving a card that stopped for no visible reason. Written to the board it survives, and the human can see on the Prompt Kanban exactly which work is blocked on them and what it is blocked on.',
    inputSchema: {
      type: 'object',
      properties: {
        question: {
          type: 'string',
          description: 'What you need the human to decide or supply, in full — they may read it days later with none of this chat in front of them.',
        },
      },
      required: ['question'],
      additionalProperties: false,
    },
  },
  {
    name: 'prompt_status',
    description:
      'Move a card on the prompt board, optionally recording what came back. BOSS ONLY. Use it when an agent reports finishing (move to review with their result), when you have checked the work (move to done), or to put a card back to to-do because it was not really started. Moving a card to done is a statement that somebody looked at the work — do not use it to clear a queue you have not read.',
    inputSchema: {
      type: 'object',
      properties: {
        prompt: { type: 'string', description: 'The card\'s id from prompt_board, or distinctive words from its text.' },
        status: {
          type: 'string',
          enum: ['todo', 'in-progress', 'awaiting-input', 'review', 'done', 'later'],
          description:
            'The column to move it to. Use "later" to PARK a card the human has said to leave for now — it stops being worked on, is released from whoever had it, and stays on the board to be picked up another day. Never park a card on your own judgement that it is unimportant; that is the human\'s call.',
        },
        question: {
          type: 'string',
          description: 'Only with awaiting-input: what the human has to answer before this can go on.',
        },
        result: { type: 'string', description: 'What came back — one short paragraph, and where the work is.' },
      },
      required: ['prompt', 'status'],
      additionalProperties: false,
    },
  },
]
