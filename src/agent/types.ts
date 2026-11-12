/**
 * The seams of the harness, in one file.
 *
 * Four parts meet here and nowhere else: the loop that talks to the model (`agent/`), the tools that touch this
 * computer or Memtro (`tools/`), the gate that decides whether a tool call may run (`safety/`), and whatever is
 * showing the session to a person or a program (`tui/`, `commands/run.ts`). Each depends on these types and on
 * none of the others' modules, so a part can be replaced, or tested against a fake, without the rest.
 *
 * Nothing in this file does anything. If a type here has to change, every part changes with it.
 */

// ---------------------------------------------------------------------------------------------------------------
// Tools
// ---------------------------------------------------------------------------------------------------------------

/** What the model is shown: a name, a sentence, and a JSON Schema object for the arguments. */
export interface ToolSpec {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

/**
 * What running a call would do, which is what the gate judges.
 *
 * `read` looks at files or state on this computer. `write` creates or changes a file. `execute` starts a
 * process. `remote-read` asks Memtro (memory, a connected system) for something; `remote-act` asks Memtro to
 * change something in a connected system. The platform gates the remote two itself; the harness still shows them.
 */
export type Risk = "read" | "write" | "execute" | "remote-read" | "remote-act";

/** One line a person can read before saying yes, plus what the gate's rules look at. */
export interface CallSummary {
  /** "Run `npm test`", "Edit src/cli.ts", "Read ~/.ssh/config". */
  title: string;
  /** Absolute paths the call reads or writes, when it names any. */
  paths?: string[];
  /** The shell command exactly as it would be run, for `execute`. */
  command?: string;
  /** A unified diff of the change, for `write`, when one can be computed before running. */
  diff?: string;
}

export interface ToolContext {
  /** Where the session was started; relative paths resolve against it. */
  cwd: string;
  /** The repository root when there is one, otherwise `cwd`. Writes outside it are a different risk. */
  workspaceRoot: string;
  /** Aborted when the person interrupts the turn. A tool stops what it started (and its children). */
  signal: AbortSignal;
  /** Output as it arrives, for a long command. Display only; the model sees `ToolResult.content`. */
  onProgress?: (text: string) => void;
}

export type ToolDisplay =
  | { kind: "text"; text: string }
  | { kind: "diff"; path: string; diff: string }
  | { kind: "command"; command: string; exitCode: number | null; output: string };

export interface ToolResult {
  /** What the model sees. Already cut to size; says so when it was cut, and how to get the rest. */
  content: string;
  /** True when the tool failed. The model is told; the turn goes on. */
  isError?: boolean;
  /** What a person sees, when that should differ from `content` (a diff, a command's output). */
  display?: ToolDisplay;
}

export interface Tool<A = Record<string, unknown>> {
  spec: ToolSpec;
  /** Checks arguments the model sent. A failure goes back to the model as an error result; nothing runs. */
  validate(raw: unknown): { ok: true; args: A } | { ok: false; error: string };
  /** The risk of this call, which can depend on its arguments (a path outside the workspace). Never throws. */
  risk(args: A, ctx: Pick<ToolContext, "cwd" | "workspaceRoot">): Risk;
  /** What to show and what the gate inspects. May read the disk to compute a diff; never changes anything. */
  summarise(args: A, ctx: Pick<ToolContext, "cwd" | "workspaceRoot">): Promise<CallSummary> | CallSummary;
  run(args: A, ctx: ToolContext): Promise<ToolResult>;
}

// ---------------------------------------------------------------------------------------------------------------
// The gate: may this call run?
// ---------------------------------------------------------------------------------------------------------------

/** A tool call the model asked for, after validation, before anything has run. */
export interface PendingCall {
  /** The model's `tool_call_id`. */
  id: string;
  tool: string;
  args: Record<string, unknown>;
  risk: Risk;
  summary: CallSummary;
}

/**
 * `allow` runs it. `ask` puts it to the person. `deny` refuses it and tells the model why.
 *
 * The same three words Memtro's own gates use (brain `Verdict`), on purpose.
 */
export type Verdict = "allow" | "ask" | "deny";

export interface Decision {
  verdict: Verdict;
  /** One sentence, shown to the person and, on a refusal, to the model. */
  reason: string;
  /**
   * Who decided. `mode`: the session's mode settles it without looking further. `rule`: a built-in or configured
   * rule. `session`: the person said "allow this for the session" earlier. `classifier`: the model that judges
   * calls. `fallback`: the classifier was off, unreachable, slow or unreadable, so the cautious answer was used.
   */
  source: "mode" | "rule" | "session" | "classifier" | "fallback";
}

/**
 * How much the person is asked.
 *
 * `ask`: every write, command and remote action is put to them. `auto`: the classifier judges those and only its
 * doubts are put to them; with no classifier this behaves exactly as `ask`. `unchecked`: nothing is judged or
 * asked (the flag that turns it on is named so nobody sets it by accident).
 */
export type Mode = "ask" | "auto" | "unchecked";

/** What the gate may look at besides the call. Deliberately not the tool results or the model's own words. */
export interface GateContext {
  /** What the person has typed this session, oldest first. The only statement of intent the classifier trusts. */
  userMessages: string[];
  /** Earlier calls this turn as `title` strings, so "the third `rm`" can be seen as that. No results. */
  earlierCalls: string[];
  cwd: string;
  workspaceRoot: string;
  signal: AbortSignal;
}

/** Something the person agreed to for the rest of the session. */
export type SessionRule =
  /** This exact command line. */
  | { kind: "command"; command: string }
  /** Any command starting with these words, e.g. ["npm", "test"]. */
  | { kind: "command-prefix"; words: string[] }
  /** Writes to files under this absolute directory. */
  | { kind: "write-under"; dir: string }
  /** Any call of this tool (used for a remote tool by name). */
  | { kind: "tool"; tool: string };

export interface Gate {
  readonly mode: Mode;
  setMode(mode: Mode): void;
  /** Never throws: a failure inside the gate is a `fallback` decision of `ask`. */
  check(call: PendingCall, ctx: GateContext): Promise<Decision>;
  /** Records a session rule the person agreed to. A rule can never cover something the built-in rules always ask about. */
  remember(rule: SessionRule): void;
  /** The rule that "allow for this session" would record for this call, or null when it may only be allowed once. */
  suggestRule(call: PendingCall): SessionRule | null;
}

export type Answer =
  | { kind: "once" }
  | { kind: "session"; rule: SessionRule }
  /** `note` is what the person typed for the model ("use pnpm, not npm"). */
  | { kind: "deny"; note?: string };

/** Whoever can be asked. With nobody there (a headless run), the implementation answers `deny`. */
export interface Approver {
  ask(call: PendingCall, decision: Decision, suggested: SessionRule | null): Promise<Answer>;
}

/**
 * One forced function call to a model, returning that call's arguments, or null when the reply was anything else.
 *
 * The classifier is written against this so it can be tested without a network and so the loop's transport is the
 * only place that knows what a chat completion looks like. Rejects on a network failure or timeout.
 */
export type ForcedCall = (request: {
  model: string;
  system: string;
  user: string;
  tool: ToolSpec;
  maxTokens: number;
  timeoutMs: number;
  signal: AbortSignal;
}) => Promise<Record<string, unknown> | null>;

// ---------------------------------------------------------------------------------------------------------------
// The conversation, as it is sent and as it is saved
// ---------------------------------------------------------------------------------------------------------------

export interface ToolCallRequest {
  id: string;
  name: string;
  /** JSON text exactly as the model produced it; parsed by the loop, kept verbatim for the next request. */
  arguments: string;
}

/** OpenAI's chat message shapes, which is what `/v1/chat/completions` takes. */
export type Message =
  | { role: "system"; content: string }
  | { role: "user"; content: string }
  | { role: "assistant"; content: string | null; tool_calls?: ToolCallRequest[] }
  | { role: "tool"; tool_call_id: string; content: string };

export interface Usage {
  input: number;
  output: number;
  /** Input tokens read from the provider's cache, when it says. */
  cached?: number;
}

// ---------------------------------------------------------------------------------------------------------------
// What a session emits, for a terminal or for a program reading JSON lines
// ---------------------------------------------------------------------------------------------------------------

export type EndReason = "stop" | "length" | "interrupted" | "error" | "step-limit";

/**
 * Everything that happens in a turn, in order. The terminal draws these; `memtro run --json` prints one per line,
 * unchanged, so this shape is a public interface: add to it, do not rename within it.
 */
export type AgentEvent =
  | { type: "turn-start"; session: string; model: string }
  /** Which model Memtro chose for this step, when it says. `detail` is Memtro's routing note as sent. */
  | { type: "routing"; model: string | null; detail: unknown }
  | { type: "text"; delta: string }
  | { type: "thinking"; delta: string }
  | { type: "tool-call"; call: PendingCall }
  | { type: "tool-decision"; id: string; decision: Decision; answer?: Answer }
  | { type: "tool-progress"; id: string; text: string }
  | { type: "tool-result"; id: string; tool: string; result: ToolResult }
  | { type: "usage"; step: Usage; session: Usage; contextUsed: number; contextLimit: number | null }
  | { type: "compacted"; before: number; after: number }
  /** Something worth a line that is not an error: a retry, a fallback, a limit approached. */
  | { type: "notice"; text: string }
  | { type: "error"; message: string; retryable: boolean }
  | { type: "turn-end"; reason: EndReason };

export interface Agent {
  readonly sessionId: string;
  readonly model: string;
  setModel(model: string): void;
  /** One turn: the person's text in, events out until the model stops asking for tools. Aborting ends it cleanly. */
  run(text: string, signal: AbortSignal): AsyncIterable<AgentEvent>;
  /** Summarises the older part of the conversation now. Yields `compacted`, or `notice` when there was nothing to do. */
  compact(signal: AbortSignal): AsyncIterable<AgentEvent>;
  /** The conversation so far, without the system prompt. */
  messages(): readonly Message[];
}

// ---------------------------------------------------------------------------------------------------------------
// Sessions on disk
// ---------------------------------------------------------------------------------------------------------------

export interface SessionMeta {
  id: string;
  cwd: string;
  /** ISO time the session was started. */
  started: string;
  model: string;
  /** The first thing the person typed, cut short, for a list somebody picks from. */
  title: string;
}

export interface SessionStore {
  create(meta: SessionMeta): void;
  appendMessage(id: string, message: Message): void;
  /** Replaces everything before this point with a summary when the session is loaded again. */
  appendCompaction(id: string, summary: string, keptFrom: number): void;
  /** Newest first, for this directory only. */
  list(cwd: string): SessionMeta[];
  load(id: string): { meta: SessionMeta; messages: Message[] } | null;
}
