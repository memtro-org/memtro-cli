import { realpathSync } from "node:fs";
import { homedir } from "node:os";
import type { ApiClient } from "../api/client.js";
import { forcedCallVia } from "../api/chat.js";
import { cheapestKnownModel, explicitModelsUsable, listModels, type ModelInfo } from "../api/models.js";
import { createAgent } from "../agent/loop.js";
import { openSessionStore, sessionsDir } from "../agent/session-store.js";
import type { Agent, Approver, Gate, Message, Mode, SessionMeta, SessionRule, SessionStore, Tool } from "../agent/types.js";
import { bool, str, type Flags } from "../args.js";
import { harnessSettings, type HarnessConfig } from "../config.js";
import type { Context } from "../context.js";
import { AuthError, errorText, UsageError } from "../errors.js";
import { gitProject, gitRoot } from "../git.js";
import { broadWorkspace } from "../safety/gate.js";
import { createGate } from "../safety/index.js";
import { acceptRule } from "../safety/session-rules.js";
import { createLocalTools } from "../tools/index.js";
import { loadMemtroTools } from "../tools/memtro.js";

/**
 * The one place a session is put together: client, models, tools, gate, approver, store and agent, from the flags
 * and the config file. The interactive session and `memtro run` both start here, so the two cannot drift apart on
 * what is checked.
 */

export const DEFAULT_MODEL = "auto";
/** The classifier's model when the account lets us name none: the organisation's default (sent as `memtro:chat`). */
export const FALLBACK_CLASSIFIER_MODEL = "memtro";

export const UNCHECKED_WARNING =
  "memtro: --unchecked: no tool call is checked or asked about. Commands and edits run as soon as the model asks, with your account's permissions.";

/** The id without a `:chat` suffix. `:agent` is refused: Memtro's agent inside this one is minutes per step. */
export function normaliseModel(id: string): string {
  const t = id.trim();
  if (!t) throw new UsageError("A model id cannot be empty.");
  if (/:agent$/.test(t)) throw new UsageError(`"${t}" would run Memtro's own agent inside this one. Use the id without ":agent".`);
  return t.replace(/:chat$/, "");
}

/** Whether `id` is in the list (suffixes ignored). */
export function modelListed(models: ModelInfo[], id: string): boolean {
  const bare = id.replace(/:(chat|agent)$/, "");
  return models.some((m) => m.id.replace(/:(chat|agent)$/, "") === bare);
}

export function resolveMode(flags: Flags, settings: HarnessConfig): Mode {
  const flag = str(flags.mode);
  if (bool(flags.unchecked)) {
    if (flag) throw new UsageError("Give --mode or --unchecked, not both.");
    return "unchecked";
  }
  if (flag !== undefined) {
    if (flag !== "ask" && flag !== "auto") throw new UsageError(`--mode must be "ask" or "auto"; got "${flag}".`);
    return flag;
  }
  return settings.mode ?? "auto";
}

/** The rules `--allow-edits` and `--allow <prefix>` start the session with. */
export function initialRules(flags: Flags, workspaceRoot: string): SessionRule[] {
  const rules: SessionRule[] = [];
  if (bool(flags["allow-edits"])) rules.push({ kind: "write-under", dir: workspaceRoot });
  const allow = flags.allow;
  for (const prefix of Array.isArray(allow) ? allow : typeof allow === "string" ? [allow] : []) {
    const words = prefix.split(/\s+/).filter(Boolean);
    if (!words.length) throw new UsageError("--allow needs the start of a command, e.g. --allow \"npm test\".");
    rules.push({ kind: "command-prefix", words });
  }
  return rules;
}

export interface ClassifierChoice {
  /** Bare model id, or null when the safety check's model is off. */
  model: string | null;
  /** True when it is the organisation's default model rather than a small one picked for the job. */
  orgDefault: boolean;
  notice: string;
}

/** Which model judges tool calls, and the one line that says so. Pure. */
export function chooseClassifier(input: { off: "flag" | "config" | null; configured?: string; models: ModelInfo[] | null; mode: Mode }): ClassifierChoice {
  if (input.mode === "unchecked") return { model: null, orgDefault: false, notice: "" };
  if (input.off) {
    const why = input.off === "flag" ? "--no-classifier" : "classifier.enabled is false in config.json";
    return {
      model: null,
      orgDefault: false,
      notice: `The safety check's model is off (${why}): every edit, command and remote action it would judge is put to you${input.mode === "auto" ? ", so auto works like ask" : ""}.`,
    };
  }
  if (input.configured) {
    const model = input.configured.replace(/:chat$/, "");
    return { model, orgDefault: false, notice: `Tool calls are judged by ${model} (classifier.model in config.json).` };
  }
  const cheap = input.models && explicitModelsUsable(input.models) ? cheapestKnownModel(input.models) : null;
  if (cheap) return { model: cheap, orgDefault: false, notice: `Tool calls are judged by ${cheap}.` };
  const why = input.models === null ? "the model list could not be loaded" : "this account can only use routed models";
  return {
    model: FALLBACK_CLASSIFIER_MODEL,
    orgDefault: true,
    notice:
      `Tool calls are judged by your organisation's default model (${why}), which may be a large one. ` +
      "An administrator can allow explicit model choice for the organisation so a small, cheaper model judges them.",
  };
}

export interface StartDeps {
  listModels: (client: ApiClient) => Promise<ModelInfo[]>;
  forcedCallVia: typeof forcedCallVia;
  loadMemtroTools: (client: ApiClient, opts: { actions: boolean }) => Promise<Tool[]>;
  createLocalTools: () => Tool[];
  createGate: typeof createGate;
  openSessionStore: typeof openSessionStore;
  createAgent: (options: Parameters<typeof createAgent>[0]) => Agent;
  home: string;
  platform: NodeJS.Platform;
}

const defaultDeps = (): StartDeps => ({
  listModels,
  forcedCallVia,
  loadMemtroTools,
  createLocalTools,
  createGate,
  openSessionStore,
  createAgent,
  home: homedir(),
  platform: process.platform,
});

export interface Resume {
  meta: SessionMeta;
  messages: Message[];
}

export interface Session {
  client: ApiClient;
  cwd: string;
  workspaceRoot: string;
  project: string | null;
  store: SessionStore;
  gate: Gate;
  /** Null when `/v1/models` could not be read. */
  models: ModelInfo[] | null;
  classifier: ClassifierChoice;
  /** Lines worth showing once at the start (a fallback, an unreachable part). */
  notices: string[];
  /** `--resume` with no id: the caller asks which. */
  pickResume: boolean;
  /** Where this directory's prompt history is kept beside the sessions. */
  sessionsDir: string;
  agent: Agent;
  actions(): boolean;
  tools(): Tool[];
  contextLimit(model: string): number | null;
  /** A fresh agent (resuming `resume` when given), which becomes `agent`. */
  newAgent(resume?: Resume): Agent;
  /** The current conversation, carried into a new agent (after the tools changed). */
  carryOn(): Agent;
  /** Reloads Memtro's tools with actions on or off. Returns the line to show; the session is unchanged on failure. */
  setActions(on: boolean): Promise<string>;
}

const realOr = (p: string): string => {
  try {
    return realpathSync(p);
  } catch {
    return p;
  }
};

/** A refused key ends the session; anything else that fails while loading is a notice and the session goes on. */
async function settle<T>(p: Promise<T>): Promise<{ ok: true; value: T } | { ok: false; err: unknown }> {
  try {
    return { ok: true, value: await p };
  } catch (err) {
    if (err instanceof AuthError) throw err;
    return { ok: false, err };
  }
}

export async function startSession(ctx: Context, opts: { approver: Approver; interactive: boolean; deps?: Partial<StartDeps> }): Promise<Session> {
  const d = { ...defaultDeps(), ...opts.deps };
  const settings = harnessSettings(ctx.config);
  const mode = resolveMode(ctx.flags, settings);
  if (bool(ctx.flags.continue) && str(ctx.flags.resume) !== undefined) throw new UsageError("Give --continue or --resume, not both.");
  const flagModel = str(ctx.flags.model);
  const requested = flagModel !== undefined ? normaliseModel(flagModel) : undefined;
  if (mode === "unchecked") ctx.stderr.write(`${ctx.err.red(UNCHECKED_WARNING)}\n`);

  const client = await ctx.client();
  const cwd = realOr(ctx.cwd);
  const workspaceRoot = realOr(gitRoot(cwd) ?? cwd);
  const project = gitProject(cwd);
  const rules = initialRules(ctx.flags, workspaceRoot);
  const notices: string[] = [];
  const home = realOr(d.home);
  if (mode !== "unchecked" && (broadWorkspace(workspaceRoot, home, d.platform) || broadWorkspace(workspaceRoot, d.home, d.platform))) {
    notices.push(
      `The workspace (${workspaceRoot}) is your home directory or above it, so nothing here counts as inside a project: every read, edit and command is checked` +
        (bool(ctx.flags["allow-edits"]) ? ", and --allow-edits has no effect, since edits there are never allowed wholesale." : ". Start memtro inside a project for fewer questions."),
    );
  }

  let actions = bool(ctx.flags.actions) || settings.actions === true;
  const [modelsR, memtroR] = await Promise.all([settle(d.listModels(client)), settle(d.loadMemtroTools(client, { actions }))]);
  const models = modelsR.ok ? modelsR.value : null;
  if (!modelsR.ok) notices.push(`Could not list models (${errorText(modelsR.err)}): context limits are unknown, so the conversation is not compacted automatically.`);
  let memtroTools: Tool[] = memtroR.ok ? memtroR.value : [];
  if (!memtroR.ok) {
    actions = false;
    notices.push(`Could not load Memtro's tools (${errorText(memtroR.err)}); this session has the local tools only.`);
  }
  if (requested && models && !modelListed(models, requested)) {
    throw new UsageError(`"${requested}" is not a model this account offers. Offered: ${models.map((m) => m.id).join(", ") || "none"}.`);
  }

  const off = bool(ctx.flags["no-classifier"]) ? "flag" : settings.classifier.enabled === false ? "config" : null;
  const classifier = chooseClassifier({ off, configured: settings.classifier.model, models, mode });
  if (classifier.notice) notices.push(classifier.notice);
  if (actions) notices.push("Actions are on: Memtro's tools can change connected systems, and each such call is checked.");

  for (const rule of rules) {
    if (rule.kind !== "command-prefix") continue;
    if (!acceptRule(rule, { home: d.home, platform: d.platform, configDir: ctx.dir, workspaceRoot })) {
      notices.push(`--allow "${rule.words.join(" ")}" is ignored: it covers something that is always put to a person, which no allowance can.`);
    }
  }
  const gate = d.createGate({
    mode,
    classifier: classifier.model ? { call: d.forcedCallVia(client), model: classifier.model } : null,
    home: d.home,
    platform: d.platform,
    configDir: ctx.dir,
    initialRules: rules,
  });
  const store = d.openSessionStore({ env: ctx.env, platform: d.platform, home: d.home });
  const local = d.createLocalTools();
  const byModel = new Map((models ?? []).map((m) => [m.id.replace(/:(chat|agent)$/, ""), m.context]));
  const contextLimit = (model: string) => byModel.get(model.replace(/:(chat|agent)$/, "")) ?? null;

  let resume: Resume | undefined;
  let pickResume = false;
  const resumeFlag = str(ctx.flags.resume);
  if (bool(ctx.flags.continue)) {
    const newest = store.list(cwd)[0];
    const loaded = newest ? store.load(newest.id) : null;
    if (loaded) resume = loaded;
    else notices.push("No earlier session in this directory; starting a new one.");
  } else if (resumeFlag === "") {
    if (!opts.interactive) throw new UsageError("--resume needs a session id here (nobody is there to pick one). --continue takes this directory's most recent.");
    pickResume = true;
  } else if (resumeFlag !== undefined) {
    let loaded: Resume | null = null;
    try {
      loaded = store.load(resumeFlag);
    } catch {
      loaded = null;
    }
    if (!loaded) throw new UsageError(`No session "${resumeFlag}" on this computer. \`memtro --resume\` lists this directory's.`);
    resume = loaded;
  }

  const session: Session = {
    client,
    cwd,
    workspaceRoot,
    project,
    store,
    gate,
    models,
    classifier,
    notices,
    pickResume,
    sessionsDir: sessionsDir({ env: ctx.env, platform: d.platform, home: d.home }),
    agent: undefined as unknown as Agent,
    actions: () => actions,
    tools: () => [...local, ...memtroTools],
    contextLimit,
    newAgent(r?: Resume) {
      const model = requested ?? r?.meta.model.replace(/:(chat|agent)$/, "") ?? session.agent?.model ?? DEFAULT_MODEL;
      session.agent = d.createAgent({
        client,
        model: session.agent && !r ? session.agent.model : model,
        tools: session.tools(),
        gate,
        approver: opts.approver,
        store,
        cwd,
        workspaceRoot,
        project,
        contextLimit,
        ...(r ? { resume: r } : {}),
      });
      return session.agent;
    },
    carryOn() {
      const current = session.agent;
      let meta: SessionMeta | null = null;
      try {
        meta = store.load(current.sessionId)?.meta ?? null;
      } catch {
        meta = null;
      }
      const agent = d.createAgent({
        client,
        model: current.model,
        tools: session.tools(),
        gate,
        approver: opts.approver,
        store,
        cwd,
        workspaceRoot,
        project,
        contextLimit,
        ...(meta ? { resume: { meta, messages: [...current.messages()] } } : {}),
      });
      session.agent = agent;
      return agent;
    },
    async setActions(on: boolean) {
      if (on === actions) return on ? "Actions are already on." : "Actions are already off.";
      let next: Tool[];
      try {
        next = await d.loadMemtroTools(client, { actions: on });
      } catch (err) {
        return `Could not reload Memtro's tools (${errorText(err)}); actions are still ${actions ? "on" : "off"}.`;
      }
      memtroTools = next;
      actions = on;
      session.carryOn();
      return on
        ? "Actions on: Memtro's tools can now change connected systems, and each such call is checked before it runs."
        : "Actions off: Memtro's tools can read, not change, connected systems.";
    },
  };
  session.newAgent(resume);
  return session;
}
