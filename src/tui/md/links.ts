/**
 * Link addresses as they are shown: always the real destination, in full, cleaned.
 *
 * Only `http:`, `https:` and `mailto:` become openable links (`Style.link`); anything else (javascript:, data:,
 * file:, a relative path, a protocol-relative `//host`) is shown as plain text. An http(s) address is shown as the
 * WHATWG URL parser resolves it, so the host is the one a browser would contact (an internationalised look-alike
 * shows as its punycode, `https://good.example@evil.example` keeps the part that matters visible) and anything
 * unprintable is percent-encoded rather than hidden.
 */

export interface Address {
  /** What is printed. Never contains a control, bidi or invisible character. */
  shown: string;
  /** Set only for http(s) and mailto addresses that parsed. */
  link?: string;
}

/** The longest address printed in full; anything longer is cut with an ellipsis (a 100 KB data: URI is not prose). */
export const MAX_ADDRESS = 2000;

// Controls, spaces, bidi controls, and characters that take no space (so an address cannot hide part of itself).
const UNSAFE = /[\u0000-\u0020\u007f-\u00a0\u00ad\u034f\u061c\u115f\u1160\u17b4\u17b5\u180e\u2000-\u200f\u2028-\u202f\u205f-\u206f\u3000\u3164\ufe00-\ufe0f\ufeff\uffa0\ufff0-\ufff8]/gu;

function encodeUnsafe(text: string): string {
  return text.replace(UNSAFE, (ch) =>
    [...new TextEncoder().encode(ch)].map((b) => `%${b.toString(16).toUpperCase().padStart(2, "0")}`).join(""),
  );
}

function cap(text: string): string {
  if (text.length <= MAX_ADDRESS) return text;
  let cut = text.slice(0, MAX_ADDRESS);
  const last = cut.charCodeAt(cut.length - 1);
  if (last >= 0xd800 && last <= 0xdbff) cut = cut.slice(0, -1);
  return `${cut}…`;
}

export function address(destination: string): Address {
  const dest = destination.trim();
  if (/^(?:https?|mailto):/i.test(dest)) {
    let url: URL | null = null;
    try {
      url = new URL(dest);
    } catch {
      url = null;
    }
    if (url && (((url.protocol === "http:" || url.protocol === "https:") && url.hostname) || url.protocol === "mailto:")) {
      let href = url.href;
      // The parser adds "/" to a bare origin; showing the address as written is clearer and goes to the same place.
      if (
        (url.protocol === "http:" || url.protocol === "https:") &&
        url.pathname === "/" &&
        !url.search &&
        !url.hash &&
        !/^[a-z]+:\/\/[^/?#]*\/$/i.test(dest) &&
        href.endsWith("/")
      ) {
        href = href.slice(0, -1);
      }
      const shown = cap(encodeUnsafe(href));
      return shown.length > MAX_ADDRESS ? { shown } : { shown, link: url.href };
    }
  }
  return { shown: cap(encodeUnsafe(dest)) };
}

/** True when a link's text is its address, so it is printed once. */
export function textIsAddress(text: string, dest: string, addr: Address): boolean {
  const t = text.trim();
  if (!t) return true;
  if (t === dest.trim() || t === addr.shown) return true;
  if (addr.link?.startsWith("mailto:") && `mailto:${t}` === addr.link) return true;
  if (addr.link && /^https?:\/\//i.test(t)) {
    try {
      const other = new URL(t).href;
      return other === addr.link;
    } catch {
      return false;
    }
  }
  return false;
}

/**
 * Where a bare address in prose ends (GitHub's extended autolinks): at whitespace or `<`, then without trailing
 * punctuation, an unbalanced closing parenthesis, or an entity-looking `&x;`.
 */
export function trimBareUrl(candidate: string): string {
  let url = candidate;
  for (;;) {
    const before = url;
    url = url.replace(/[?!.,:*_~'"]+$/, "");
    if (url.endsWith(")")) {
      let open = 0;
      let close = 0;
      for (const ch of url) {
        if (ch === "(") open++;
        else if (ch === ")") close++;
      }
      if (close > open) url = url.slice(0, -1);
    }
    const entity = /&[a-z0-9]+;$/i.exec(url);
    if (entity) url = url.slice(0, entity.index);
    if (url === before) return url;
  }
}
