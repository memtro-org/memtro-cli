import type { TtyIn } from "./keys.js";

/**
 * The terminal's state, put back on every way out.
 *
 * The session turns on bracketed paste and, between prompts, raw mode. Whatever ends the process (a normal exit,
 * an error, SIGINT, SIGTERM, SIGHUP, an uncaught exception) the shell gets its terminal back as it was: raw mode
 * off, bracketed paste off, cursor shown.
 */

export const BRACKETED_PASTE_ON = "\u001b[?2004h";
/** Bracketed paste off, cursor shown. */
export const RESTORE = "\u001b[?2004l\u001b[?25h";

export interface TerminalGuard {
  restore(): void;
  /** Restores and removes every handler it added. */
  dispose(): void;
}

type Proc = Pick<NodeJS.Process, "on" | "off" | "listenerCount" | "exit">;

export function guardTerminal(input: TtyIn, output: NodeJS.WritableStream, proc: Proc = process, errOut: NodeJS.WritableStream = process.stderr): TerminalGuard {
  output.write(BRACKETED_PASTE_ON);
  // Not once-only: raw mode is turned on again after every prompt, so every exit path puts it back.
  const restore = () => {
    try {
      input.setRawMode?.(false);
    } catch {
      // the stream may already be closed
    }
    try {
      output.write(RESTORE);
    } catch {
      // nothing more to be done
    }
  };
  const onExit = () => restore();
  const bySignal = (code: number) => () => {
    restore();
    proc.exit(code);
  };
  const onTerm = bySignal(143);
  const onHup = bySignal(129);
  // In cooked mode (signing in, starting up) Ctrl-C is a signal. Anybody else listening (the sign-in's own handler) decides.
  const onInt = () => {
    if (proc.listenerCount("SIGINT") > 1) return;
    restore();
    proc.exit(130);
  };
  const onCrash = (err: unknown) => {
    restore();
    errOut.write(`memtro: unexpected error: ${err instanceof Error ? err.message : String(err)}\n`);
    proc.exit(1);
  };
  proc.on("exit", onExit);
  proc.on("SIGTERM", onTerm);
  proc.on("SIGHUP", onHup);
  proc.on("SIGINT", onInt);
  proc.on("uncaughtException", onCrash);
  proc.on("unhandledRejection", onCrash);
  return {
    restore,
    dispose() {
      restore();
      proc.off("exit", onExit);
      proc.off("SIGTERM", onTerm);
      proc.off("SIGHUP", onHup);
      proc.off("SIGINT", onInt);
      proc.off("uncaughtException", onCrash);
      proc.off("unhandledRejection", onCrash);
    },
  };
}
