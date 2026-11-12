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

// Anything that could stand for a dot in a host name (IDNA maps the ideographic and fullwidth full stops to ".").
const DOTS = /[。．｡]/g;
// Characters that take no space or reorder text: removed before looking, so "pay​pal.com" reads as paypal.com.
const INVISIBLE = /[­͏؜ᅟᅠ឴឵᠎​-‏‪-‮⁠-⁯ㅤ︀-️﻿ﾠ]/gu;
/** A scheme followed by `//`, or one of the schemes that take none, anywhere in the text. */
const SCHEME = /[a-z][a-z0-9+.-]*:\/\/\S*|\b(?:mailto|javascript|vbscript|data|file|tel|sms|callto|ftp):\S*/giu;
/** Something@something.something: an e-mail address (or userinfo in front of a host). */
const EMAIL = /[^\s@<>()[\]]+@[^\s@<>()[\]]+\.[^\s@<>()[\]]*[^\s@<>()[\].]/gu;
/** A host name (two or more labels, the last alphabetic or punycode) with whatever path follows it. */
const HOST = /(?<![\p{L}\p{N}_@.-])(?:[\p{L}\p{N}](?:[\p{L}\p{N}_-]*[\p{L}\p{N}])?\.)+(?:\p{L}{2,}|xn--[a-z0-9-]+)(?![\p{L}\p{N}_-])(?:[/?#:][^\s]*)?/giu;
/** An IPv4 or bracketed IPv6 address, or localhost. */
const OTHER_HOST = /(?<![\p{L}\p{N}.])\d{1,3}(?:\.\d{1,3}){3}(?![\p{N}])|\[[0-9a-f:.]+\]|\blocalhost\b/giu;

function parseHttp(text: string): URL | null {
  try {
    const u = new URL(text);
    return u.protocol === "http:" || u.protocol === "https:" ? u : null;
  } catch {
    return null;
  }
}

/**
 * Whether a link's label may itself open the link, as well as the address printed after it.
 *
 * Not when the label reads as an address that is not where the link goes: a URL with any scheme, a bare host
 * (`good.example`, `good.example/login`, with any case, a trailing slash or dot, fullwidth dots, invisible characters
 * inside, or a look-alike that a browser would contact as punycode), an e-mail address, an IP address or localhost,
 * alone or among other words ("log in at paypal.com"). Text that names the destination itself (the same host, or
 * the same full address when it gives a path or a scheme, or the same e-mail address for a mailto link) may link.
 * Only http, https and mailto addresses are ever linked. When in doubt, the label does not link.
 */
export function labelMayLink(label: string, addr: Address): boolean {
  const link = addr.link;
  if (!link) return false;
  const text = label.normalize("NFKC").replace(INVISIBLE, "").replace(DOTS, ".");
  if (!text.trim()) return false;
  const dest = parseHttp(link);
  const mailto = link.startsWith("mailto:") ? link.slice("mailto:".length).toLowerCase() : null;

  for (const m of text.matchAll(OTHER_HOST)) if (m[0]) return false;

  for (const m of text.matchAll(SCHEME)) {
    const said = trimBareUrl(m[0]);
    if (/^mailto:/i.test(said)) {
      if (mailto === null || said.slice("mailto:".length).toLowerCase() !== mailto) return false;
      continue;
    }
    const u = parseHttp(said);
    if (!u || !dest || u.href !== dest.href || /xn--/i.test(u.hostname) || /[^\x00-\x7f]/.test(said)) return false;
  }

  // E-mail addresses first, and blanked out so their host part is not read again as a host.
  let rest = text;
  for (const m of text.matchAll(EMAIL)) {
    const said = trimBareUrl(m[0]).replace(/^mailto:/i, "").toLowerCase();
    if (mailto === null || said !== mailto) return false;
    rest = rest.replace(m[0], " ");
  }
  // Hosts, outside what the scheme pass already judged.
  rest = rest.replace(SCHEME, " ");
  for (const m of rest.matchAll(HOST)) {
    const said = trimBareUrl(m[0]);
    if (!dest) return false;
    const u = parseHttp(`http://${said}`);
    if (!u || u.hostname !== dest.hostname) return false;
    // A host written in letters that only look like ASCII ones goes where it says, but reads as somewhere else.
    if (/xn--/i.test(u.hostname) || /[^\x00-\x7f]/.test(said)) return false;
    // A path, query or fragment in the text must be the destination's own; a port must match too.
    const tail = said.slice(said.search(/[/?#:]/) >= 0 ? said.search(/[/?#:]/) : said.length);
    if (tail && tail !== "/") {
      if (u.port !== dest.port || u.pathname !== dest.pathname || u.search !== dest.search || u.hash !== dest.hash) return false;
    }
  }
  return true;
}
