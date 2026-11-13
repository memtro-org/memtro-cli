import type { Risk } from "../agent/types.js";
import { onRestore } from "./terminal.js";
import { oneLine, visible } from "./sanitise.js";

/**
 * Asking for the person's attention when memtro needs them and they are looking elsewhere: an approval is waiting,
 * or a long turn has finished.
 *
 * What is sent depends on the terminal (see `attentionChannel`), and every byte of it is built here, by pure
 * functions, so it is tested rather than described:
 *
 * - iTerm2: OSC 9, iTerm2's "post a notification" sequence. It is output to a background tab, so the tab shows its
 *   blue new-output dot; and when the profile's "Notification Center alerts" (off by default) and, under Filter
 *   Alerts, "Send escape sequence-generated alerts" (on by default) are on, iTerm2 posts a macOS notification and
 *   adds one to the Dock badge. For an
 *   approval, also OSC 21337 with the status Claude Code's iTerm2 integration uses for "waiting on you" (a blue
 *   #5f87ff dot and the word "waiting" on the tab, in iTerm2 3.7 and later; earlier versions ignore it silently),
 *   cleared again when the approval is answered. No bell: with "Show bell icon in tabs" on, iTerm2 draws a bell in
 *   place of the dot.
 * - kitty: OSC 99, its own notification protocol. Ghostty and WezTerm: OSC 9, which both document as a desktop
 *   notification.
 * - Everything else, and anything inside tmux or GNU screen: the bell (BEL), which every terminal understands. tmux
 *   swallows OSC 9 (it reads only 9;4 and 9;9) but by default marks the window and passes a bell on.
 *
 * Nothing in a notification comes from the model, a tool or a file: the text says what kind of call is waiting
 * ("run a command"), never the command. `notificationText` still cleans whatever it is given, so no change here can
 * ever let a BEL or ESC \ end our sequence early and start one of its own.
 */

export type NotifySetting = "auto" | "bell" | "off";
export type Channel = "iterm2" | "kitty" | "osc9" | "bell" | "none";

const ESC = "\u001b";
const ST = `${ESC}\\`;
export const BEL = "\u0007";

/** How many characters of text a notification carries at most. */
export const NOTIFY_MAX = 100;
/** With no word from the terminal about focus, an approval still open after this long signals (Claude Code waits about six seconds). */
export const UNKNOWN_FOCUS_MS = 6000;
/** A turn that took at least this long signals when it finishes (only when the terminal said it is not focused). */
export const LONG_TURN_MS = 10_000;

/** The status Claude Code's iTerm2 integration shows while it waits on the person: iTerm2's own colours for "waiting". */
export const ITERM_WAITING = `${ESC}]21337;status=waiting;indicator=#5f87ff;status-color=#5f87ff${ST}`;
/** Clears that status (an empty value clears each field, per iTerm2's documentation). */
export const ITERM_CLEAR = `${ESC}]21337;status=;indicator=;status-color=${ST}`;

/** Which way to ask for attention in this terminal. Pure over the environment and the setting. */
export function attentionChannel(env: NodeJS.ProcessEnv, setting: NotifySetting): Channel {
  if (setting === "off") return "none";
  if (setting === "bell") return "bell";
  const term = env.TERM ?? "";
  if (term === "dumb") return "none";
  // A multiplexer first: the variables of the terminal outside it (LC_TERMINAL, KITTY_WINDOW_ID) are inherited, but
  // what we write goes to tmux or screen, which do not pass OSC 9 on.
  if (env.TMUX || env.STY || term.startsWith("tmux") || term.startsWith("screen")) return "bell";
  const program = env.TERM_PROGRAM ?? "";
  if (program === "iTerm.app" || env.LC_TERMINAL === "iTerm2" || env.ITERM_SESSION_ID) return "iterm2";
  if (env.KITTY_WINDOW_ID || term === "xterm-kitty") return "kitty";
  if (program === "ghostty" || term === "xterm-ghostty" || program === "WezTerm") return "osc9";
  return "bell";
}

/**
 * Text that is safe inside an OSC string: cleaned as a title is (`oneLine(visible(…))`: every control character
 * becomes a visible picture), then anything that is still a C0 or C1 control or DEL removed, as a second lock, and
 * cut to `NOTIFY_MAX` characters. A BEL or ESC \ in the input can therefore never end our sequence.
 */
export function notificationText(text: string): string {
  const clean = oneLine(visible(text))
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, "")
    .replace(/\s+/g, " ")
    .trim();
  const chars = Array.from(clean);
  return chars.length > NOTIFY_MAX ? `${chars.slice(0, NOTIFY_MAX - 1).join("")}…` : clean;
}

/** What kind of call is waiting, in words: chosen by its risk, never from the model's text. */
export function approvalWhat(risk: Risk): string {
  switch (risk) {
    case "execute":
      return "run a command";
    case "write":
      return "change a file";
    case "read":
      return "read a file";
    case "remote-read":
      return "read from Memtro";
    case "remote-act":
      return "act in a connected system";
  }
}

export const approvalMessage = (risk: Risk): string => `memtro needs you: allow it to ${approvalWhat(risk)}?`;
export const FINISHED_MESSAGE = "memtro has finished and is waiting for you";

/**
 * The exact bytes for one signal. `waiting` (an approval, in iTerm2) adds the tab status. The text is always put
 * through `notificationText`, and starts with "memtro", so OSC 9 can never be read as 9;4 (a progress bar).
 */
export function attentionBytes(channel: Channel, message: string, o: { waiting?: boolean } = {}): string {
  const text = notificationText(message);
  switch (channel) {
    case "none":
      return "";
    case "bell":
      return BEL;
    case "iterm2":
      return `${ESC}]9;${text}${ST}${o.waiting ? ITERM_WAITING : ""}`;
    case "kitty":
      return `${ESC}]99;;${text}${ST}`;
    case "osc9":
      return `${ESC}]9;${text}${ST}`;
  }
}

export interface AttentionOptions {
  setting: NotifySetting;
  env: NodeJS.ProcessEnv;
  /** Writes straight to the terminal, between frames. Never called for a stdout that is not a terminal. */
  write: (bytes: string) => void;
  /** Runs `fn` after `ms`; returns a function that cancels it. Tests pass their own. */
  setTimer?: (fn: () => void, ms: number) => () => void;
}

const realTimer = (fn: () => void, ms: number): (() => void) => {
  const t = setTimeout(fn, ms);
  t.unref?.();
  return () => clearTimeout(t);
};

/**
 * When to signal, once per event. An approval signals at once if the terminal has said it is not focused; if it is
 * focused, on the first focus-out while the approval is still open; if the terminal has said nothing about focus,
 * when the approval has been open `UNKNOWN_FOCUS_MS`. A finished turn signals only when it took `LONG_TURN_MS` or
 * more and the terminal has said it is not focused. Writes only: it reads no keys and decides nothing.
 */
export class Attention {
  readonly channel: Channel;
  private focus: boolean | null = null;
  private open: { risk: Risk; signalled: boolean; cancel: (() => void) | null } | null = null;
  private statusSet = false;
  private unregister: (() => void) | null = null;
  private readonly setTimer: (fn: () => void, ms: number) => () => void;

  constructor(private readonly o: AttentionOptions) {
    this.channel = attentionChannel(o.env, o.setting);
    this.setTimer = o.setTimer ?? realTimer;
  }

  /** What the terminal said about focus (CSI I / CSI O). */
  setFocus(focused: boolean): void {
    this.focus = focused;
    const a = this.open;
    if (!a || a.signalled) return;
    if (focused) {
      // Known to be looking now: no timer; a later focus-out signals instead.
      a.cancel?.();
      a.cancel = null;
    } else this.signalApproval();
  }

  approvalOpened(risk: Risk): void {
    this.approvalClosed();
    if (this.channel === "none") return;
    this.open = { risk, signalled: false, cancel: null };
    if (this.focus === false) this.signalApproval();
    else if (this.focus === null) {
      const a = this.open;
      a.cancel = this.setTimer(() => {
        a.cancel = null;
        if (this.open === a) this.signalApproval();
      }, UNKNOWN_FOCUS_MS);
    }
  }

  approvalClosed(): void {
    const a = this.open;
    this.open = null;
    a?.cancel?.();
    this.clearStatus();
  }

  turnFinished(tookMs: number): void {
    if (this.channel === "none" || this.focus !== false || tookMs < LONG_TURN_MS) return;
    this.o.write(attentionBytes(this.channel, FINISHED_MESSAGE));
  }

  /** The session is ending: nothing left behind on the tab. */
  dispose(): void {
    this.approvalClosed();
  }

  private signalApproval(): void {
    const a = this.open;
    if (!a || a.signalled) return;
    a.signalled = true;
    a.cancel?.();
    a.cancel = null;
    const waiting = this.channel === "iterm2";
    this.o.write(attentionBytes(this.channel, approvalMessage(a.risk), { waiting }));
    if (waiting) {
      this.statusSet = true;
      // A crash or a signal while the approval is open still takes the "waiting" status off the tab.
      this.unregister = onRestore(() => this.clearStatus());
    }
  }

  private clearStatus(): void {
    if (!this.statusSet) return;
    this.statusSet = false;
    this.unregister?.();
    this.unregister = null;
    this.o.write(ITERM_CLEAR);
  }
}
