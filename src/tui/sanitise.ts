/**
 * Text from the model, a tool or a file on its way to a terminal.
 *
 * A terminal obeys whatever control sequences reach it: a file's contents could move the cursor over an approval
 * prompt, set the window title, or put text on the clipboard (OSC 52). So nothing that came from outside reaches
 * the terminal with its controls intact. Each control character is replaced by a visible stand-in, which disarms
 * every sequence it starts (an ESC that is no longer an ESC starts nothing) and shows that something was there.
 *
 * Kept: newline and tab. Everything else in C0, DEL and C1 is replaced, and so are the bidirectional overrides
 * that can make text read in a different order from the one it runs in.
 */

/** U+2400 + code is the Unicode picture of each C0 control: ␛ for ESC, ␍ for CR, ␇ for BEL. */
const picture = (code: number): string => String.fromCharCode(0x2400 + code);

const hex = (code: number): string => `\\u${code.toString(16).padStart(4, "0")}`;

/** Bidi embeddings, overrides and isolates (the "Trojan Source" set). */
const BIDI = /[‪-‮⁦-⁩]/;
/** Characters that take no space, so a command can carry text nobody sees. */
const INVISIBLE = /[​-‏⁠-⁤﻿­]/;

function replaceControls(text: string, keep: (ch: string) => boolean, extra: RegExp | null): string {
  let out = "";
  for (const ch of text) {
    const code = ch.codePointAt(0)!;
    if (keep(ch)) out += ch;
    else if (code < 0x20) out += picture(code);
    else if (code === 0x7f) out += "␡";
    else if (code >= 0x80 && code <= 0x9f) out += hex(code);
    else if (BIDI.test(ch) || (extra && extra.test(ch))) out += hex(code);
    else out += ch;
  }
  return out;
}

/** For prose and file contents: controls made visible, newlines and tabs kept. */
export function sanitise(text: string): string {
  if (!/[\u0000-\u0008\u000b-\u001f\u007f-\u009f‪-‮⁦-⁩]/.test(text)) return text;
  return replaceControls(text.replace(/\r\n/g, "\n"), (ch) => ch === "\n" || ch === "\t", null);
}

/**
 * For a command shown before somebody agrees to run it: every control, invisible and bidi character is shown,
 * including carriage return, so a command cannot hide part of itself or repaint the prompt it is shown in.
 * Newlines are kept (a multi-line script is shown as lines) but tabs are shown as ␉.
 */
export function visible(text: string): string {
  return replaceControls(text, (ch) => ch === "\n", INVISIBLE);
}

/**
 * Command output for display: what a terminal would have left on each line after carriage returns (progress bars
 * redraw a line with `\r`), then sanitised.
 */
export function terminalText(text: string): string {
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  return sanitise(lines.map((line) => (line.includes("\r") ? line.slice(line.lastIndexOf("\r") + 1) : line)).join("\n"));
}

/** Single line, for titles: newlines become spaces as well. */
export function oneLine(text: string): string {
  return sanitise(text.replace(/\r?\n/g, " ").replace(/\t/g, " "));
}
