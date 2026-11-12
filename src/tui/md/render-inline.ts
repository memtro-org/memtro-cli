/** Inline trees to styled pieces ready for wrapping: emphasis, code, links with their addresses, images. */
import type { Style } from "../full/types.js";
import type { Ctx } from "./ast.js";
import { type Inline, parseInlines, plainText } from "./inlines.js";
import { address, labelMayLink, textIsAddress } from "./links.js";
import { mergeStyle, type Piece } from "./text.js";

export const CODE_STYLE: Style = { fg: "synString" };
const ADDRESS_STYLE: Style = { fg: "muted" };
const LINK_TEXT_STYLE: Style = { fg: "accent", underline: true };

function clean(text: string): string {
  return text.replace(/[\t\n]/g, " ");
}

export function imagePieces(alt: string, url: string, base: Style | undefined): Piece[] {
  const label = alt.trim() ? `[image: ${clean(alt).trim()}]` : "[image]";
  const out: Piece[] = [{ text: label, style: mergeStyle(base, { fg: "muted", italic: true }) }];
  if (url.trim()) {
    const addr = address(url);
    out.push({ text: " ", style: base });
    out.push({ text: addr.shown, style: mergeStyle(base, { ...ADDRESS_STYLE, ...(addr.link ? { link: addr.link } : {}) }) });
  }
  return out;
}

export function inlinePieces(inl: Inline[], base: Style | undefined): Piece[] {
  const out: Piece[] = [];
  const walk = (list: Inline[], style: Style | undefined) => {
    for (const x of list) {
      switch (x.t) {
        case "text":
          out.push({ text: clean(x.s), style });
          break;
        case "soft":
          out.push({ text: " ", style });
          break;
        case "br":
          out.push({ br: true });
          break;
        case "code":
        case "expr":
          out.push({ text: clean(x.s), style: mergeStyle(style, CODE_STYLE) });
          break;
        case "kbd":
          out.push({ text: "[", style: mergeStyle(style, { fg: "muted" }) });
          out.push({ text: clean(x.s), style: mergeStyle(style, { bold: true }) });
          out.push({ text: "]", style: mergeStyle(style, { fg: "muted" }) });
          break;
        case "em":
          walk(x.c, mergeStyle(style, { italic: true }));
          break;
        case "strong":
          walk(x.c, mergeStyle(style, { bold: true }));
          break;
        case "del":
          walk(x.c, mergeStyle(style, { strike: true }));
          break;
        case "group":
          walk(x.c, style);
          break;
        case "image":
          out.push(...imagePieces(x.alt, x.url, style));
          break;
        case "link": {
          const addr = address(x.url);
          const linked = addr.link ? { ...LINK_TEXT_STYLE, link: addr.link } : undefined;
          const text = plainText(x.c);
          const hasImage = x.c.some((c) => c.t === "image");
          if (x.auto || x.c.length === 0 || (!hasImage && textIsAddress(text, x.url, addr))) {
            // `<me@example.com>` shows the address as written; anything else shows the destination itself.
            const email = addr.link?.startsWith("mailto:") && `mailto:${text.trim()}` === addr.link ? clean(text.trim()) : "";
            out.push({ text: email || addr.shown, style: mergeStyle(style, linked) });
            break;
          }
          // The label opens the same address as the one printed after it, unless the label itself reads as an
          // address or host that is not that destination ("[https://good.example](https://evil.example)", "log in at
          // paypal.com"): then only the printed address opens anything, so what a terminal opens is always what is
          // shown. A label holding an image never links (the image's own address is printed inside it).
          const labelLinks = !hasImage && labelMayLink(text, addr);
          walk(x.c, mergeStyle(style, labelLinks ? linked : LINK_TEXT_STYLE));
          out.push({ text: " ", style });
          out.push({ text: `(${addr.shown})`, style: mergeStyle(style, { ...ADDRESS_STYLE, ...(addr.link ? { link: addr.link } : {}) }) });
          break;
        }
      }
    }
  };
  walk(inl, base);
  return out;
}

/** Inline Markdown source (a paragraph, heading or cell) to pieces, resolving references as the context allows. */
export function markdownPieces(text: string, seq: number, ctx: Ctx, base?: Style): Piece[] {
  const inl = parseInlines(text, {
    ctx,
    ref: (label) => {
      const def = ctx.refs.get(label);
      if (!def) return undefined;
      // While streaming, a definition that arrives later must not reshape a paragraph already shown.
      if (ctx.streaming && def.seq > seq) return undefined;
      return def.dest;
    },
  });
  return inlinePieces(inl, base);
}
