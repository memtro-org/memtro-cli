import type { ColourDepth, Rgb, Role, Theme } from "../types.js";

/**
 * Colours by role, and how each depth of terminal shows them.
 *
 * Memtro's teal (the brochure's `--accent`: #36706a on light, #6cc0b4 on dark, with its own foregrounds) is the
 * accent in both themes; the neutrals follow the brochure's (#181818 text, #646873 muted, #f4f5f6 raised surface)
 * and are pushed where a terminal needs more contrast than a page. Every pair the interface draws text on is checked
 * by `contrastReport` (WCAG 2 contrast ratio), and the test holds the thresholds.
 */

const hex = (h: string): Rgb => {
  const n = Number.parseInt(h.slice(1), 16);
  return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
};

function theme(name: string, dark: boolean, c: Record<Role, string>): Theme {
  const colours = {} as Record<Role, Rgb>;
  for (const [k, v] of Object.entries(c)) colours[k as Role] = hex(v);
  return { name, dark, colours };
}

export const darkTheme: Theme = theme("dark", true, {
  page: "#101213",
  panel: "#1b1e20",
  dialog: "#212528",
  backdrop: "#08090a",
  rule: "#30363a",
  text: "#e6e9ea",
  muted: "#a1a8ad",
  faint: "#717a80",
  onAccent: "#0f211f",
  accent: "#6cc0b4",
  user: "#6ea8fe",
  success: "#62c98f",
  warning: "#e8b75a",
  danger: "#f07a85",
  info: "#72c2e6",
  heading: "#b89dff",
  codeBg: "#171a1c",
  added: "#86dca0",
  addedBg: "#13291d",
  removed: "#f39196",
  removedBg: "#311619",
  synKeyword: "#c79bff",
  synString: "#a8d88c",
  synNumber: "#f0b36e",
  synComment: "#7f888e",
  synFunction: "#6fc2f0",
  synType: "#7fd3c7",
  synPunct: "#a9b1b6",
});

export const lightTheme: Theme = theme("light", false, {
  page: "#ffffff",
  panel: "#f1f3f4",
  dialog: "#ffffff",
  backdrop: "#9aa0a6",
  rule: "#dfe2e5",
  text: "#181818",
  muted: "#595e67",
  faint: "#80858c",
  onAccent: "#ffffff",
  accent: "#36706a",
  user: "#2c62c9",
  success: "#227553",
  warning: "#8a5800",
  danger: "#c0334f",
  info: "#1d6b94",
  heading: "#6a46c2",
  codeBg: "#f4f5f6",
  added: "#1b6a3c",
  addedBg: "#e2f3e7",
  removed: "#b0243b",
  removedBg: "#fbe5e8",
  synKeyword: "#7a35ad",
  synString: "#2d6e30",
  synNumber: "#975700",
  synComment: "#6a6f77",
  synFunction: "#1d5ea7",
  synType: "#2f6a64",
  synPunct: "#4a4f57",
});

// ---------------------------------------------------------------------------------------------------------------
// Contrast
// ---------------------------------------------------------------------------------------------------------------

const channel = (v: number) => {
  const s = v / 255;
  return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
};

export function luminance(c: Rgb): number {
  return 0.2126 * channel(c.r) + 0.7152 * channel(c.g) + 0.0722 * channel(c.b);
}

/** WCAG 2 contrast ratio, 1 to 21. */
export function contrast(a: Rgb, b: Rgb): number {
  const la = luminance(a);
  const lb = luminance(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

export interface ContrastRow {
  fg: Role;
  bg: Role;
  ratio: number;
  /** The least this pair must reach. */
  min: number;
  ok: boolean;
}

/** The pairs text is drawn on, and what each must reach: 7:1 for body text, 4.5:1 for the rest. */
export const CONTRAST_PAIRS: ReadonlyArray<[Role, Role, number]> = [
  ["text", "page", 7],
  ["text", "panel", 7],
  ["text", "dialog", 7],
  ["muted", "page", 4.5],
  ["muted", "panel", 4.5],
  ["muted", "dialog", 4.5],
  ["onAccent", "accent", 4.5],
  ["added", "addedBg", 4.5],
  ["removed", "removedBg", 4.5],
  ["text", "codeBg", 7],
  ["accent", "page", 4.5],
  ["user", "page", 4.5],
  ["success", "page", 4.5],
  ["warning", "page", 4.5],
  ["danger", "page", 4.5],
  ["info", "page", 4.5],
  ["heading", "page", 4.5],
  ["warning", "panel", 4.5],
  ["synKeyword", "codeBg", 4.5],
  ["synString", "codeBg", 4.5],
  ["synNumber", "codeBg", 4.5],
  ["synComment", "codeBg", 4.5],
  ["synFunction", "codeBg", 4.5],
  ["synType", "codeBg", 4.5],
  ["synPunct", "codeBg", 4.5],
  ["faint", "page", 3],
];

export function contrastReport(t: Theme): ContrastRow[] {
  return CONTRAST_PAIRS.map(([fg, bg, min]) => {
    const ratio = Math.round(contrast(t.colours[fg], t.colours[bg]) * 100) / 100;
    return { fg, bg, ratio, min, ok: ratio >= min };
  });
}

/** `a` moved towards `b` by `t` (0..1). */
export function blend(a: Rgb, b: Rgb, t: number): Rgb {
  return {
    r: Math.round(a.r + (b.r - a.r) * t),
    g: Math.round(a.g + (b.g - a.g) * t),
    b: Math.round(a.b + (b.b - a.b) * t),
  };
}

// ---------------------------------------------------------------------------------------------------------------
// Depth
// ---------------------------------------------------------------------------------------------------------------

/**
 * How much colour the terminal shows. `NO_COLOR` (non-empty) and `TERM=dumb` mean none; `FORCE_COLOR` 0-3 overrides
 * the rest (0 none, 1 sixteen, 2 256, 3 truecolor); then `COLORTERM`, the terminal program, and `TERM`. A stream that
 * is not a terminal gets none unless forced.
 */
export function detectDepth(env: NodeJS.ProcessEnv, stream: { isTTY?: boolean }): ColourDepth {
  if (env.NO_COLOR !== undefined && env.NO_COLOR !== "") return "none";
  const force = env.FORCE_COLOR;
  if (force !== undefined) {
    if (force === "0" || force === "false") return "none";
    if (force === "2") return "256";
    if (force === "3") return "truecolor";
    if (force === "" || force === "1" || force === "true") return "16";
  }
  if (env.TERM === "dumb") return "none";
  if (!stream.isTTY) return "none";
  const ct = (env.COLORTERM ?? "").toLowerCase();
  if (ct === "truecolor" || ct === "24bit") return "truecolor";
  const prog = env.TERM_PROGRAM ?? "";
  if (/^(iTerm\.app|WezTerm|vscode|ghostty|Hyper|Tabby|rio)$/i.test(prog)) return "truecolor";
  const term = (env.TERM ?? "").toLowerCase();
  if (/(-direct|truecolor|24bit|kitty|alacritty|foot|wezterm|ghostty)/.test(term)) return "truecolor";
  if (term.includes("256") || prog === "Apple_Terminal") return "256";
  if (env.WT_SESSION) return "truecolor";
  if (term === "linux" || term.startsWith("xterm") || term.startsWith("screen") || term.startsWith("tmux") || term.startsWith("vt") || term.startsWith("rxvt") || term === "ansi" || term === "cygwin") return "16";
  return term ? "16" : "none";
}

// ---------------------------------------------------------------------------------------------------------------
// 256 colours
// ---------------------------------------------------------------------------------------------------------------

const CUBE = [0, 95, 135, 175, 215, 255];

/** OKLab: a perceptual space, so "nearest" keeps hue (a teal stays teal rather than becoming the nearest grey). */
function oklab(c: Rgb): [number, number, number] {
  const r = channel(c.r);
  const g = channel(c.g);
  const b = channel(c.b);
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  return [
    0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
    1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
    0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s,
  ];
}

/** The 240 fixed entries of the xterm palette (16-255), in OKLab. */
const PALETTE_256: Array<{ index: number; lab: [number, number, number] }> = [];
for (let i = 16; i < 256; i++) {
  let c: Rgb;
  if (i < 232) {
    const n = i - 16;
    c = { r: CUBE[Math.floor(n / 36)]!, g: CUBE[Math.floor(n / 6) % 6]!, b: CUBE[n % 6]! };
  } else {
    const v = 8 + (i - 232) * 10;
    c = { r: v, g: v, b: v };
  }
  PALETTE_256.push({ index: i, lab: oklab(c) });
}

const cache256 = new Map<number, number>();

/**
 * The nearest xterm-256 index in the 6×6×6 cube (16-231) or the grey ramp (232-255), by OKLab distance with chroma
 * weighted up, so a coloured role keeps its hue instead of collapsing into a grey of the same lightness.
 */
export function to256(c: Rgb): number {
  const key = (c.r << 16) | (c.g << 8) | c.b;
  const hit = cache256.get(key);
  if (hit !== undefined) return hit;
  const [L, A, B] = oklab(c);
  let best = 16;
  let bestD = Number.POSITIVE_INFINITY;
  for (const p of PALETTE_256) {
    const dl = L - p.lab[0];
    const da = A - p.lab[1];
    const db = B - p.lab[2];
    const d = dl * dl + 2 * (da * da + db * db);
    if (d < bestD) {
      bestD = d;
      best = p.index;
    }
  }
  cache256.set(key, best);
  return best;
}

// ---------------------------------------------------------------------------------------------------------------
// 16 colours: by hand, so the meaning survives (a selected row is cyan with black text, whatever the palette)
// ---------------------------------------------------------------------------------------------------------------

/** ANSI 16 index for a role used as a foreground; null = the terminal's default. */
const FG16: Record<Role, number | null> = {
  page: null, panel: null, dialog: null, backdrop: null, rule: 8,
  text: null, muted: 8, faint: 8, onAccent: 0,
  accent: 6, user: 4, success: 2, warning: 3, danger: 1, info: 6, heading: 5,
  codeBg: null, added: 2, addedBg: null, removed: 1, removedBg: null,
  synKeyword: 5, synString: 2, synNumber: 3, synComment: 8, synFunction: 4, synType: 6, synPunct: null,
};

/** ANSI 16 index for a role used as a background; null = the terminal's default. Only the selection is filled. */
const BG16: Partial<Record<Role, number>> = { accent: 6, user: 4, warning: 3, danger: 1, success: 2, info: 6 };

/**
 * Whether a cell's glyph cannot be shown at this depth: drawn in a surface colour (a half-block edge in the panel's
 * colour), where surfaces are the terminal's own background. The writer draws a space instead.
 */
export function invisibleAt(s: CellStyle, depth: ColourDepth): boolean {
  return (depth === "none" || depth === "16") && s.fg !== undefined && BG_ROLES.has(s.fg) && (s.bg === undefined || BG16[s.bg] === undefined);
}

/** Roles that are surfaces: at 16 colours and none they are the terminal's default background. */
const BG_ROLES = new Set<Role>(["page", "panel", "dialog", "backdrop", "codeBg", "addedBg", "removedBg"]);

const fg16 = (i: number) => (i < 8 ? 30 + i : 90 + i - 8);
const bg16 = (i: number) => (i < 8 ? 40 + i : 100 + i - 8);

export interface CellStyle {
  fg?: Role;
  bg?: Role;
  bold?: boolean;
  dim?: boolean;
  italic?: boolean;
  underline?: boolean;
  strike?: boolean;
  /** Drawn behind a dialog: colours moved towards `backdrop` (or SGR faint where colours cannot move). */
  dimmed?: boolean;
}

/** How much a dimmed cell moves towards the backdrop. */
export const DIM_AMOUNT = 0.55;

/**
 * SGR parameters for a cell style at a depth, as a list (joined with ";" by the writer). Always complete: the writer
 * opens each run with a reset so nothing leaks from the run before.
 */
export function sgrParams(s: CellStyle, t: Theme, depth: ColourDepth): string[] {
  const p: string[] = [];
  if (s.bold) p.push("1");
  if (s.italic) p.push("3");
  if (s.underline) p.push("4");
  if (s.strike) p.push("9");
  if (depth === "none") {
    if (s.dim || s.dimmed) p.push("2");
    // No colour: what a coloured background meant (a selected row, a badge) is kept as reverse video.
    if (s.bg && BG16[s.bg] !== undefined) p.push("7");
    return p;
  }
  if (depth === "16") {
    if (s.dim || s.dimmed) p.push("2");
    const f = s.fg ? FG16[s.fg] : null;
    const b = s.bg ? BG16[s.bg] : undefined;
    if (f !== null && f !== undefined) p.push(String(fg16(f)));
    if (b !== undefined) p.push(String(bg16(b)));
    return p;
  }
  if (s.dim) p.push("2");
  const c = t.colours;
  const page = c.page;
  let fg = s.fg ? c[s.fg] : c.text;
  let bg = s.bg ? c[s.bg] : page;
  if (s.dimmed) {
    fg = blend(fg, c.backdrop, DIM_AMOUNT);
    bg = blend(bg, c.backdrop, DIM_AMOUNT);
  }
  if (depth === "truecolor") {
    p.push(`38;2;${fg.r};${fg.g};${fg.b}`, `48;2;${bg.r};${bg.g};${bg.b}`);
  } else {
    p.push(`38;5;${to256(fg)}`, `48;5;${to256(bg)}`);
  }
  return p;
}

// ---------------------------------------------------------------------------------------------------------------
// The terminal's background (OSC 11 reply)
// ---------------------------------------------------------------------------------------------------------------

/**
 * The colour in an OSC 10/11 reply body (`rgb:RRRR/GGGG/BBBB`, 1-4 hex digits a channel, or `#rrggbb`), or null
 * for anything else. Strict: nothing but the colour is accepted.
 */
export function parseOscColour(body: string): Rgb | null {
  const m = /^rgba?:([0-9a-f]{1,4})\/([0-9a-f]{1,4})\/([0-9a-f]{1,4})(?:\/[0-9a-f]{1,4})?$/i.exec(body);
  if (m) {
    const scale = (h: string) => Math.round((Number.parseInt(h, 16) / (16 ** h.length - 1)) * 255);
    return { r: scale(m[1]!), g: scale(m[2]!), b: scale(m[3]!) };
  }
  const h = /^#([0-9a-f]{6})$/i.exec(body);
  return h ? hex(`#${h[1]}`) : null;
}

/** Whether a background reads as dark. */
export function isDarkBackground(c: Rgb): boolean {
  return luminance(c) < 0.18;
}
