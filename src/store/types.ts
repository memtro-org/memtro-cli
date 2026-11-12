import type { StoreKind } from "../config.js";

/**
 * Somewhere to keep one API key per profile.
 *
 * `get` answers null for "there is no key" and throws for "could not ask": a keychain that is locked or a file
 * with the wrong permissions is not the same thing as being signed out, and reading it as signed out would send
 * somebody round the login flow to fix a problem the login flow cannot fix.
 */
export interface CredentialStore {
  readonly kind: StoreKind;
  /** Where the key is, for a person: "the macOS Keychain", "~/.config/memtro/credentials.json". */
  readonly where: string;
  get(profile: string): Promise<string | null>;
  set(profile: string, key: string): Promise<void>;
  /** True if something was removed, false if there was nothing to remove. */
  delete(profile: string): Promise<boolean>;
}

/** Every key Memtro issues starts with this; anything else read back from a store is not one of ours. */
export const KEY_PREFIX = "sk-memtro-";
const LEGACY_PREFIXES = ["sk-brain-"];

/** The characters a key is made of (`sk-memtro-` + base64url). Checked before a key goes anywhere near a command stream. */
const KEY_SHAPE = /^sk-(memtro|brain)-[A-Za-z0-9_-]{8,256}$/;

export function looksLikeKey(value: string): boolean {
  return KEY_SHAPE.test(value) && (value.startsWith(KEY_PREFIX) || LEGACY_PREFIXES.some((p) => value.startsWith(p)));
}
