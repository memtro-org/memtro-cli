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

export const LOGIN_HINT = "Run `memtro login` to sign in again.";

export function refusedKey(profile: string): AuthError {
  return new AuthError(`Memtro refused the key for profile "${profile}": it has been revoked or has expired. ${LOGIN_HINT}`);
}

export function notSignedIn(profile: string): AuthError {
  return new AuthError(`Not signed in (profile "${profile}"). Run \`memtro login\`, or set MEMTRO_API_KEY.`);
}

export function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
