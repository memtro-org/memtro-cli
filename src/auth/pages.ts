/**
 * What the browser sees after the redirect back to this computer.
 *
 * Self-contained (no scripts, no fonts, no images, nothing fetched) and served with a CSP that forbids all of it,
 * so the page cannot call anywhere even if somebody found a way to put text in it. Nothing variable is ever
 * written into it: no code, no state, no key, no name. A person needs to know whether it worked and that they
 * can go back to the terminal; nothing else belongs on a page that lives in their browser history.
 */

export type PageKind = "success" | "cancelled" | "failed" | "not-found";

const COPY: Record<PageKind, { title: string; heading: string; body: string }> = {
  success: {
    title: "Memtro CLI: signed in",
    heading: "You are signed in",
    body: "The terminal has its key. You can close this tab and go back to it.",
  },
  cancelled: {
    title: "Memtro CLI: cancelled",
    heading: "Sign-in cancelled",
    body: "Nothing was issued. You can close this tab; run memtro login again whenever you are ready.",
  },
  failed: {
    title: "Memtro CLI: sign-in failed",
    heading: "Sign-in did not complete",
    body: "The terminal says what went wrong. You can close this tab and run memtro login again.",
  },
  "not-found": {
    title: "Not found",
    heading: "Nothing here",
    body: "This address belongs to a memtro login that is waiting for one specific redirect.",
  },
};

export const PAGE_HEADERS = {
  "Content-Type": "text/html; charset=utf-8",
  "Cache-Control": "no-store",
  "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
  "Referrer-Policy": "no-referrer",
  "X-Content-Type-Options": "nosniff",
} as const;

export function page(kind: PageKind): string {
  const c = COPY[kind];
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light dark">
<meta name="referrer" content="no-referrer">
<title>${c.title}</title>
<style>
:root { color-scheme: light dark; font-family: system-ui, -apple-system, "Segoe UI", sans-serif; line-height: 1.5; }
body { margin: 0; min-height: 100vh; display: grid; place-items: center; background: Canvas; color: CanvasText; }
main { max-width: 32rem; padding: 2rem 1.5rem; }
h1 { font-size: 1.5rem; margin: 0 0 .5rem; }
p { margin: 0; }
</style>
</head>
<body>
<main>
<h1>${c.heading}</h1>
<p>${c.body}</p>
</main>
</body>
</html>
`;
}
