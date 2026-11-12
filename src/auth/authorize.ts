/**
 * The authorize address, and whether this terminal can be expected to open a browser for it.
 */

export const MANUAL = "manual";

/**
 * `device`: display only, on the approval page. The host name is what a person recognises their own machine by.
 * The platform trims it, strips control characters and truncates it to 64 characters itself, so it is sent as it
 * is apart from dropping control characters, which have no business in a URL a person may read.
 */
export function deviceLabel(hostname: string): string {
  // eslint-disable-next-line no-control-regex
  return hostname.replace(/[\u0000-\u001f\u007f-\u009f]/g, "").trim();
}

export function loopbackRedirect(port: number): string {
  if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error(`The loopback port ${port} is outside 1024-65535.`);
  return `http://127.0.0.1:${port}/callback`;
}

export function buildAuthorizeUrl(base: string, p: { challenge: string; redirectUri: string; state: string; device?: string }): string {
  const url = new URL(`${base.replace(/\/+$/, "")}/cli/authorize`);
  url.searchParams.set("code_challenge", p.challenge);
  url.searchParams.set("code_challenge_method", "S256");
  url.searchParams.set("redirect_uri", p.redirectUri);
  url.searchParams.set("state", p.state);
  if (p.device) url.searchParams.set("device", p.device);
  return url.toString();
}

/**
 * Whether to skip the browser and ask for the code to be pasted.
 *
 * Over SSH the browser that would open is on the wrong computer (if it opens at all), and its redirect to
 * 127.0.0.1 would land on that computer too. A Linux desktop session sets DISPLAY or WAYLAND_DISPLAY; without
 * either there is nothing to open a browser on. Either way, pasting needs a person at a terminal, so this is
 * only chosen automatically when stdin is one; otherwise the loopback flow runs and the URL is printed, which
 * still works for somebody forwarding the port.
 */
export function wantsManual(input: { noBrowser: boolean; env: NodeJS.ProcessEnv; platform: NodeJS.Platform; stdinIsTTY: boolean }): boolean {
  if (input.noBrowser) return true;
  if (!input.stdinIsTTY) return false;
  const { env } = input;
  if (env.SSH_CONNECTION || env.SSH_TTY || env.SSH_CLIENT) return true;
  if (input.platform === "linux" && !env.DISPLAY && !env.WAYLAND_DISPLAY) return true;
  return false;
}

/** A pasted code: trimmed, base64url only. The contract's codes are 43 characters; a little latitude either side. */
export function cleanPastedCode(raw: string): string | null {
  const code = raw.trim();
  return /^[A-Za-z0-9_-]{16,256}$/.test(code) ? code : null;
}
