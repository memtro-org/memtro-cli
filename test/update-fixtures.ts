// A local HTTP server standing in for GitHub releases, and tarball builders, for the updater and installer tests.
// Nothing here reaches the network: every URL is 127.0.0.1.
import { createHash } from "node:crypto";
import { createServer, type IncomingHttpHeaders, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { gzipSync } from "node:zlib";

export interface TarEntry {
  name: string;
  data?: Buffer;
  mode?: number;
  /** "0" regular file (default), "2" symlink, "5" directory, "x" pax header… */
  type?: string;
  linkname?: string;
}

/** A ustar archive of the given entries, gzip-compressed. */
export function tarGz(entries: TarEntry[]): Buffer {
  const parts: Buffer[] = [];
  for (const e of entries) {
    const data = e.data ?? Buffer.alloc(0);
    const header = Buffer.alloc(512);
    const put = (text: string, offset: number, length: number): void => void header.write(text, offset, length, "utf8");
    const num = (value: number, offset: number, length: number): void => put(`${value.toString(8).padStart(length - 1, "0")}\0`, offset, length);
    put(e.name, 0, 100);
    num(e.mode ?? 0o755, 100, 8);
    num(0, 108, 8);
    num(0, 116, 8);
    num(data.length, 124, 12);
    num(1_700_000_000, 136, 12);
    header.fill(0x20, 148, 156);
    put(e.type ?? "0", 156, 1);
    if (e.linkname) put(e.linkname, 157, 100);
    put("ustar\0", 257, 6);
    put("00", 263, 2);
    let sum = 0;
    for (const b of header) sum += b;
    put(`${sum.toString(8).padStart(6, "0")}\0 `, 148, 8);
    parts.push(header, data, Buffer.alloc((512 - (data.length % 512)) % 512));
  }
  parts.push(Buffer.alloc(1024));
  return gzipSync(Buffer.concat(parts));
}

/** A stand-in executable: a shell script that prints `version` for `--version` (or exits `exitCode`). */
export function fakeExecutable(version: string, exitCode = 0): Buffer {
  return Buffer.from(`#!/bin/sh\nif [ "$1" = "--version" ]; then echo "${version}"; exit ${exitCode}; fi\necho "fake memtro ${version}"\n`);
}

export const sha256 = (data: Buffer | string): string => createHash("sha256").update(data).digest("hex");

export interface Release {
  tag: string;
  /** file name → contents */
  files: Record<string, Buffer | string>;
}

export interface FakeGitHub {
  base: string;
  port: number;
  requests: Array<{ url: string; headers: IncomingHttpHeaders }>;
  /** Override the handling of a path: return true when handled. */
  intercept: ((path: string, res: ServerResponse) => boolean) | null;
  /** The tag `releases/latest` and `releases/latest/download/*` point at; null for 404. */
  latestTag: string | null;
  releases: Map<string, Release>;
  close(): Promise<void>;
}

/**
 * Serves `/releases/latest` (302 to `/releases/tag/<tag>`), `/releases/latest/download/<f>` (302 to the tag's
 * download URL) and `/releases/download/<tag>/<f>`, as github.com does.
 */
export async function fakeGitHub(): Promise<FakeGitHub> {
  const state: Omit<FakeGitHub, "base" | "port" | "close"> = { requests: [], intercept: null, latestTag: null, releases: new Map() };
  const server: Server = createServer((req, res) => {
    const path = new URL(req.url ?? "/", "http://x").pathname;
    state.requests.push({ url: path, headers: req.headers });
    if (state.intercept?.(path, res)) return;
    if (path === "/releases/latest") {
      if (!state.latestTag) return void res.writeHead(404).end("Not Found");
      return void res.writeHead(302, { location: `http://127.0.0.1:${port}/releases/tag/${state.latestTag}` }).end();
    }
    const latest = /^\/releases\/latest\/download\/([^/]+)$/.exec(path);
    if (latest) {
      if (!state.latestTag) return void res.writeHead(404).end("Not Found");
      return void res.writeHead(302, { location: `/releases/download/${state.latestTag}/${latest[1]}` }).end();
    }
    const dl = /^\/releases\/download\/([^/]+)\/([^/]+)$/.exec(path);
    const file = dl ? state.releases.get(decodeURIComponent(dl[1]!))?.files[dl[2]!] : undefined;
    if (file === undefined) return void res.writeHead(404).end("Not Found");
    const body = Buffer.isBuffer(file) ? file : Buffer.from(file);
    res.writeHead(200, { "content-type": "application/octet-stream", "content-length": body.length }).end(body);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  return Object.assign(state, {
    base: `http://127.0.0.1:${port}/releases`,
    port,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  }) as FakeGitHub;
}

/** A release with a tarball (and checksums.txt and latest.json) for each of the given os-arch names. */
export function makeRelease(version: string, executables: Record<string, Buffer>, opts: { tamper?: string } = {}): Release {
  const files: Record<string, Buffer | string> = {};
  const assets: Record<string, { file: string; sha256: string }> = {};
  const sums: string[] = [];
  for (const [target, exe] of Object.entries(executables)) {
    const file = `memtro-${target}.tar.gz`;
    files[file] = tarGz([{ name: "memtro", data: exe }]);
    const sum = sha256(files[file] as Buffer);
    assets[target] = { file, sha256: sum };
    sums.push(`${opts.tamper === target ? "0".repeat(64) : sum}  ${file}`);
  }
  files["checksums.txt"] = `${sums.join("\n")}\n`;
  files["latest.json"] = JSON.stringify({ version, tag: `v${version}`, published: new Date(0).toISOString(), assets });
  return { tag: `v${version}`, files };
}
