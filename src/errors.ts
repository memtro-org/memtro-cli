/**
 * Exit codes, decided once.
 *
 * People read the message; scripts and agents read the code, and the three things they most need to tell apart
 * are "I asked wrongly", "I am not signed in" and "Memtro could not be reached". Each has its own number so a
 * retry loop can retry the last and never the first two.
 */
export const EXIT = {
  ok: 0,
  failure: 1,
  usage: 2,
  auth: 3,
  unavailable: 4,
} as const;

export type ExitCode = (typeof EXIT)[keyof typeof EXIT];

export class CliError extends Error {
  readonly exitCode: ExitCode;
  constructor(message: string, exitCode: ExitCode = EXIT.failure) {
    super(message);
    this.name = "CliError";
    this.exitCode = exitCode;
  }
}

/** The command line itself was wrong. Nothing was sent anywhere. */
export class UsageError extends CliError {
  constructor(message: string) {
    super(message, EXIT.usage);
    this.name = "UsageError";
  }
}

/** No key, or Memtro refused the one we have. The message always ends with what to run. */
export class AuthError extends CliError {
  constructor(message: string) {
    super(message, EXIT.auth);
    this.name = "AuthError";
  }
}

/** Memtro could not be reached, timed out, or said it is unavailable. Worth retrying. */
export class UnavailableError extends CliError {
  constructor(message: string) {
    super(message, EXIT.unavailable);
    this.name = "UnavailableError";
  }
}

/** How a person gets a key: there is no login command, the first command that needs one signs in. */
export const SIGN_IN_HINT = "Run `memtro` in a terminal to sign in again.";

/** What somebody typing the old login command is told (exit 2). */
export const NO_LOGIN_COMMAND = "There is no login command: run `memtro` and it signs you in.";

/** Memtro answered 401: the key is revoked or expired. Only this, never a network failure or a 5xx, is a refusal. */
export class KeyRefusedError extends AuthError {
  /** Where the refused key came from: MEMTRO_API_KEY is never replaced by signing in. */
  readonly source: "env" | "stored";
  constructor(message: string, source: "env" | "stored") {
    super(message);
    this.name = "KeyRefusedError";
    this.source = source;
  }
}

export function refusedKey(profile: string, source: "env" | "stored" = "stored"): KeyRefusedError {
  if (source === "env") {
    return new KeyRefusedError("Memtro refused the key in MEMTRO_API_KEY: it has been revoked or has expired. Set the variable to a valid key, or unset it to use this computer's stored key.", "env");
  }
  return new KeyRefusedError(`Memtro refused the key for profile "${profile}": it has been revoked or has expired. ${SIGN_IN_HINT}`, "stored");
}

export function notSignedIn(profile: string): AuthError {
  return new AuthError(`Not signed in${profile === "default" ? "" : ` (profile "${profile}")`}. Run \`memtro\` in a terminal to sign in, or set MEMTRO_API_KEY.`);
}

export function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
