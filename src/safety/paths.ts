/**
 * Path comparison as string work on paths the tools have already resolved.
 *
 * Nothing here touches the disk: the tools resolve `~` and symlinks before the gate sees a path, so this module only
 * normalises `.` and `..` and compares whole segments (`/home/a/.sshfoo` is not under `/home/a/.ssh`). Containment
 * is case-sensitive except on Windows, so a case mismatch reads as "outside", which is the cautious answer. The
 * credential rules use `looseSegments` instead, which is case-insensitive and splits on both separators, because
 * there a false match costs a prompt and a missed one costs a credential.
 */

/** Normalised segments of an absolute path, or null when the path is not absolute (and so cannot be placed). */
export function absoluteSegments(path: string, platform: NodeJS.Platform): string[] | null {
  if (typeof path !== "string" || path.length === 0 || path.includes("\0")) return null;
  const windows = platform === "win32";
  let text = windows ? path.replace(/\\/g, "/") : path;
  let root: string[];
  if (windows) {
    const drive = /^([A-Za-z]):\//.exec(text);
    if (drive) {
      root = [`${drive[1]!.toLowerCase()}:`];
      text = text.slice(3);
    } else if (text.startsWith("//")) {
      root = ["//"];
      text = text.slice(2);
    } else {
      return null;
    }
  } else {
    if (!text.startsWith("/")) return null;
    root = [];
    text = text.slice(1);
  }
  const out = [...root];
  for (const raw of text.split("/")) {
    const part = windows ? raw.toLowerCase() : raw;
    if (part === "" || part === ".") continue;
    if (part === "..") {
      if (out.length > root.length) out.pop();
      continue;
    }
    out.push(part);
  }
  return out;
}

/** True when `path` is `dir` or inside it, compared segment by segment. False when either cannot be placed. */
export function isInside(path: string, dir: string, platform: NodeJS.Platform): boolean {
  const p = absoluteSegments(path, platform);
  const d = absoluteSegments(dir, platform);
  if (!p || !d || p.length < d.length) return false;
  return d.every((segment, i) => p[i] === segment);
}

/** Every path inside `dir`, and at least one path. */
export function allInside(paths: readonly string[] | undefined, dir: string, platform: NodeJS.Platform): boolean {
  return Array.isArray(paths) && paths.length > 0 && paths.every((p) => isInside(p, dir, platform));
}

/**
 * Lower-cased segments for the credential rules: both separators, `..` resolved when the path is absolute, and
 * kept as written (minus empty and `.` parts) when it is not, so a relative `.ssh/id_rsa` is still seen.
 */
export function looseSegments(path: string, platform: NodeJS.Platform): string[] {
  const placed = absoluteSegments(path, platform);
  const source = placed ?? path.replace(/\\/g, "/").split("/");
  const out: string[] = [];
  for (const raw of source) {
    const part = raw.toLowerCase();
    if (part === "" || part === ".") continue;
    out.push(part);
  }
  // A POSIX name may contain a backslash; split on it too so `C:\Users\a\.ssh` on any platform is seen.
  return out.flatMap((part) => part.split("\\")).filter((part) => part !== "" && part !== ".");
}

/** True when `needle` occurs as consecutive segments of `haystack`. */
export function containsRun(haystack: readonly string[], needle: readonly string[]): boolean {
  if (needle.length === 0 || needle.length > haystack.length) return false;
  for (let i = 0; i + needle.length <= haystack.length; i++) {
    if (needle.every((segment, j) => haystack[i + j] === segment)) return true;
  }
  return false;
}

/** True when `prefix` is the start of `segments`. */
export function startsWithRun(segments: readonly string[], prefix: readonly string[]): boolean {
  return prefix.length > 0 && prefix.length <= segments.length && prefix.every((s, i) => segments[i] === s);
}

/** The directory part of an absolute path, or null when it has none. */
export function parentDir(path: string, platform: NodeJS.Platform): string | null {
  const segments = absoluteSegments(path, platform);
  if (!segments) return null;
  const windows = platform === "win32";
  const rootLength = windows ? 1 : 0;
  if (segments.length <= rootLength) return null;
  const parent = segments.slice(0, -1);
  if (windows) {
    const [root, ...rest] = parent;
    return root === "//" ? `//${rest.join("/")}` : `${root}/${rest.join("/")}`;
  }
  return `/${parent.join("/")}`;
}
