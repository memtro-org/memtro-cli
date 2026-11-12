/**
 * Colour for the session's drawing: the existing `Paint` plus the few more a transcript needs. Off means every
 * function returns its argument unchanged, so output to a pipe or under NO_COLOR has no escape codes at all.
 */
export interface Style {
  on: boolean;
  bold(s: string): string;
  dim(s: string): string;
  italic(s: string): string;
  red(s: string): string;
  green(s: string): string;
  yellow(s: string): string;
  blue(s: string): string;
  cyan(s: string): string;
  magenta(s: string): string;
}

const wrap = (on: boolean, open: number, close: number) => (s: string) => (on && s ? `\u001b[${open}m${s}\u001b[${close}m` : s);

export function style(on: boolean): Style {
  return {
    on,
    bold: wrap(on, 1, 22),
    dim: wrap(on, 2, 22),
    italic: wrap(on, 3, 23),
    red: wrap(on, 31, 39),
    green: wrap(on, 32, 39),
    yellow: wrap(on, 33, 39),
    blue: wrap(on, 34, 39),
    cyan: wrap(on, 36, 39),
    magenta: wrap(on, 35, 39),
  };
}

/** Raw codes for the streaming Markdown renderer, which opens and closes styles across writes. */
export const SGR = {
  bold: "\u001b[1m",
  boldOff: "\u001b[22m",
  code: "\u001b[36m",
  codeOff: "\u001b[39m",
  dim: "\u001b[2m",
  dimOff: "\u001b[22m",
  reset: "\u001b[0m",
} as const;
