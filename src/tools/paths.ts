import { lstatSync, readlinkSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

/**
 * Where a path the model named really is, and whether that is inside the workspace.
 *
 * The gate's rules match on the answer ("a write inside the workspace", "anything under ~/.ssh"), so the answer
 * has to be the place the bytes would actually land, not the string the model typed:
 *
 *   relative          resolved against `cwd`
 *   `~`, `~/x`        the home directory
 *   `..`              normalised away before anything is looked at
 *   symlinks          the deepest ancestor that exists is resolved with realpath (which also gives macOS's
 *                     on-disk spelling of a name typed in another case); a dangling link below it is followed
 *                     by hand, so `write` through a link that points out of the workspace is outside it
 *   Windows           `C:\x`, `C:x`, UNC; compared without regard to case, as the filesystem does
 *
 * Everything that touches the disk goes through `PathFs`, so the decision logic is tested with a fake filesystem
 * (and Windows paths are tested on any machine).
 */

export interface PathFs {
  /** The canonical path of something that exists, or null when it does not. */
  realpath(p: string): string | null;
  /** The target of a symbolic link, or null when `p` is not one (or does not exist). */
  readlink(p: string): string | null;
}

export interface PathEnv {
  cwd: string;
  workspaceRoot: string;
  home?: string;
  platform?: NodeJS.Platform;
  fs?: PathFs;
}

export interface ResolvedPath {
  /** What the model typed. */
  input: string;
  /** Absolute and normalised, symlinks not followed. */
  absolute: string;
  /** Where it really is: symlinks followed as far as they exist. Use this for every read and write. */
  real: string;
  /** True when `real` is the workspace root or below it. */
  inside: boolean;
  /** For a person: relative to `cwd` when below it, `~/…` under home, absolute otherwise. */
  display: string;
}

export const nodePathFs: PathFs = {
  realpath(p) {
    try {
      return realpathSync.native(p);
    } catch {
      return null;
    }
  },
  readlink(p) {
    try {
      return lstatSync(p).isSymbolicLink() ? readlinkSync(p) : null;
    } catch {
      return null;
    }
  },
};

const pathFor = (platform: NodeJS.Platform) => (platform === "win32" ? path.win32 : path.posix);

/** `~` and `~/rest` (and `~\rest` on Windows) become the home directory. `~user` is left alone. */
export function expandHome(input: string, home: string, platform: NodeJS.Platform = process.platform): string {
  if (input === "~") return home;
  if (input.startsWith("~/") || (platform === "win32" && input.startsWith("~\\"))) return pathFor(platform).join(home, input.slice(2));
  return input;
}

/**
 * Follows symlinks as far as the filesystem lets it: realpath on the deepest ancestor that exists, then each
 * missing component in turn, following any dangling link by hand. Bounded, as the kernel's own resolution is.
 */
export function realPath(absolute: string, fs: PathFs, platform: NodeJS.Platform = process.platform): string {
  const p = pathFor(platform);
  let current = p.normalize(absolute);
  for (let hops = 0; hops < 40; hops++) {
    const whole = fs.realpath(current);
    if (whole) return whole;
    // Find the deepest ancestor that exists.
    const tail: string[] = [];
    let dir = current;
    let base: string | null = null;
    while (true) {
      const parent = p.dirname(dir);
      tail.unshift(p.basename(dir));
      if (parent === dir) break;
      base = fs.realpath(parent);
      dir = parent;
      if (base) break;
    }
    if (!base) return current; // nothing exists, not even the root: nothing to resolve
    // Walk the missing part. The first component may be a dangling link; follow it and start again.
    let built = base;
    let followed = false;
    for (let i = 0; i < tail.length; i++) {
      const next = p.join(built, tail[i]!);
      const target = fs.readlink(next);
      if (target !== null) {
        current = p.resolve(built, target, ...tail.slice(i + 1));
        followed = true;
        break;
      }
      built = next;
    }
    if (!followed) return built;
  }
  return current;
}

/** True when `child` is `root` or below it. Case-insensitive on Windows. */
export function isWithin(root: string, child: string, platform: NodeJS.Platform = process.platform): boolean {
  const p = pathFor(platform);
  const fold = (s: string) => (platform === "win32" ? s.toLowerCase() : s);
  const rel = p.relative(fold(root), fold(child));
  if (rel === "") return true;
  if (p.isAbsolute(rel)) return false; // another drive on Windows
  return rel !== ".." && !rel.startsWith(`..${p.sep}`);
}

export function displayPath(absolute: string, cwd: string, home: string, platform: NodeJS.Platform = process.platform): string {
  const p = pathFor(platform);
  if (isWithin(cwd, absolute, platform)) {
    const rel = p.relative(cwd, absolute);
    return rel === "" ? "." : rel;
  }
  if (home && isWithin(home, absolute, platform)) {
    const rel = p.relative(home, absolute);
    return rel === "" ? "~" : `~${p.sep}${rel}`;
  }
  return absolute;
}

export function resolvePath(input: string, env: PathEnv): ResolvedPath {
  const platform = env.platform ?? process.platform;
  const home = env.home ?? homedir();
  const fs = env.fs ?? nodePathFs;
  const p = pathFor(platform);
  const absolute = p.resolve(env.cwd, expandHome(input, home, platform));
  const real = realPath(absolute, fs, platform);
  const root = realPath(p.resolve(env.workspaceRoot), fs, platform);
  return { input, absolute, real, inside: isWithin(root, real, platform), display: displayPath(absolute, env.cwd, home, platform) };
}

/**
 * The paths a call summary names: the real path, and the typed one too when a link made them differ, so a rule
 * written against either spelling sees it.
 */
export function summaryPaths(r: ResolvedPath): string[] {
  return r.real === r.absolute ? [r.real] : [r.real, r.absolute];
}
