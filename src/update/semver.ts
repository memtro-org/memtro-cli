/**
 * The small part of semver the updater needs: numeric major.minor.patch with an optional pre-release, where a
 * pre-release is older than its release. Build metadata is not accepted (releases never carry it).
 */

export interface Version {
  major: number;
  minor: number;
  patch: number;
  pre: string[];
}

const SEMVER = /^(0|[1-9]\d{0,8})\.(0|[1-9]\d{0,8})\.(0|[1-9]\d{0,8})(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/;

/** `0.2.0`, `v0.2.0` and `1.0.0-rc.1` parse; anything else (including leading zeros) is null. */
export function parseVersion(raw: string): Version | null {
  const m = SEMVER.exec(raw.startsWith("v") ? raw.slice(1) : raw);
  if (!m) return null;
  return { major: Number(m[1]), minor: Number(m[2]), patch: Number(m[3]), pre: m[4] ? m[4].split(".") : [] };
}

/** The canonical spelling without a leading `v`, or null when it is not a version. */
export function normaliseVersion(raw: string): string | null {
  const v = parseVersion(raw.trim());
  if (!v) return null;
  return `${v.major}.${v.minor}.${v.patch}${v.pre.length ? `-${v.pre.join(".")}` : ""}`;
}

/** Negative when a is older than b, 0 when equal, positive when newer. Both must be valid. */
export function compareVersions(a: string, b: string): number {
  const x = parseVersion(a);
  const y = parseVersion(b);
  if (!x || !y) throw new Error(`not a version: ${!x ? a : b}`);
  for (const key of ["major", "minor", "patch"] as const) {
    if (x[key] !== y[key]) return x[key] - y[key];
  }
  if (!x.pre.length || !y.pre.length) return (x.pre.length ? -1 : 0) - (y.pre.length ? -1 : 0);
  const n = Math.max(x.pre.length, y.pre.length);
  for (let i = 0; i < n; i++) {
    const p = x.pre[i];
    const q = y.pre[i];
    if (p === undefined) return -1;
    if (q === undefined) return 1;
    if (p === q) continue;
    const pn = /^\d+$/.test(p);
    const qn = /^\d+$/.test(q);
    if (pn && qn) return Number(p) - Number(q);
    if (pn) return -1;
    if (qn) return 1;
    return p < q ? -1 : 1;
  }
  return 0;
}
