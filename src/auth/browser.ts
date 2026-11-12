import { spawn } from "node:child_process";

/**
 * Opening the system browser.
 *
 * Always with an argument array and never through a shell: the URL carries `&`, which a shell string would read
 * as "run the rest in the background", and on Windows `start` is a cmd builtin that re-parses its arguments.
 * `rundll32 url.dll,FileProtocolHandler <url>` is the documented way to hand a URL to the default browser without
 * cmd in between.
 *
 * Failure to open is not a failure to log in: the URL is always printed as well, and the caller says so.
 */
export function browserCommand(platform: NodeJS.Platform, url: string): { command: string; args: string[] } | null {
  if (!/^https?:\/\//i.test(url)) return null;
  switch (platform) {
    case "darwin":
      return { command: "open", args: [url] };
    case "win32":
      return { command: "rundll32", args: ["url.dll,FileProtocolHandler", url] };
    case "linux":
    case "freebsd":
    case "openbsd":
    case "netbsd":
      return { command: "xdg-open", args: [url] };
    default:
      return null;
  }
}

/** Resolves true if the opener started, false otherwise. Never rejects. */
export function openBrowser(url: string, platform: NodeJS.Platform = process.platform): Promise<boolean> {
  const cmd = browserCommand(platform, url);
  if (!cmd) return Promise.resolve(false);
  return new Promise((resolve) => {
    try {
      const child = spawn(cmd.command, cmd.args, { stdio: "ignore", detached: true, shell: false, windowsHide: true });
      child.on("error", () => resolve(false));
      child.on("spawn", () => {
        child.unref();
        resolve(true);
      });
    } catch {
      resolve(false);
    }
  });
}
