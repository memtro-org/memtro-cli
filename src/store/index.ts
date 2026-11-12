import type { StoreKind } from "../config.js";
import { UsageError } from "../errors.js";
import { fileStore } from "./file.js";
import { keychainAvailable, keychainStore } from "./keychain.js";
import { findOnPath, secretToolStore } from "./secret-tool.js";
import type { CredentialStore } from "./types.js";

export type { CredentialStore } from "./types.js";

/**
 * Which store a NEW key goes into. `MEMTRO_CREDENTIALS` forces one; otherwise the platform's keychain where there
 * is one, and the file where there is not. Pure apart from the probes it is handed.
 */
export function preferredKind(
  env: NodeJS.ProcessEnv,
  probes: { keychain: () => boolean; secretTool: () => string | null } = { keychain: () => keychainAvailable(), secretTool: () => findOnPath("secret-tool", env) },
): StoreKind {
  const forced = env.MEMTRO_CREDENTIALS?.trim().toLowerCase();
  if (forced) {
    if (forced === "file" || forced === "keychain" || forced === "secret-tool") return forced;
    throw new UsageError(`MEMTRO_CREDENTIALS must be "file", "keychain" or "secret-tool"; got "${env.MEMTRO_CREDENTIALS}".`);
  }
  if (probes.keychain()) return "keychain";
  if (probes.secretTool()) return "secret-tool";
  return "file";
}

export function openStore(kind: StoreKind, configDir: string, env: NodeJS.ProcessEnv = process.env): CredentialStore {
  switch (kind) {
    case "keychain":
      if (!keychainAvailable()) throw new UsageError("The macOS Keychain is not available on this computer. Set MEMTRO_CREDENTIALS=file.");
      return keychainStore();
    case "secret-tool": {
      const binary = findOnPath("secret-tool", env);
      if (!binary) throw new UsageError("secret-tool is not on PATH. Install libsecret-tools, or set MEMTRO_CREDENTIALS=file.");
      return secretToolStore(binary);
    }
    case "file":
      return fileStore(configDir);
  }
}
