import type { Line } from "../types.js";
import { fg, span } from "./text.js";

/**
 * The `memtro` wordmark: our own lower-case letters drawn on an 8-pixel-high grid and packed two pixel rows to a
 * cell with half blocks, so it is four rows tall. "mem" in the muted tone, "tro" in the accent.
 */

const LETTERS: Record<string, string[]> = {
  m: [".......", ".......", "######.", "#..#..#", "#..#..#", "#..#..#", "#..#..#", "......."],
  e: ["......", "......", ".####.", "#....#", "######", "#.....", ".#####", "......"],
  t: [".#...", ".#...", "####.", ".#...", ".#...", ".#...", "..###", "....."],
  r: [".....", ".....", "#.##.", "##..#", "#....", "#....", "#....", "....."],
  o: ["......", "......", ".####.", "#....#", "#....#", "#....#", ".####.", "......"],
};

const WORD = "memtro";
/** Letters before this index are drawn in the first tone. */
const SPLIT = 3;

function cells(letter: string): string[] {
  const px = LETTERS[letter]!;
  const rows: string[] = [];
  for (let r = 0; r < px.length; r += 2) {
    let row = "";
    for (let c = 0; c < px[r]!.length; c++) {
      const top = px[r]![c] === "#";
      const bottom = px[r + 1]![c] === "#";
      row += top && bottom ? "█" : top ? "▀" : bottom ? "▄" : " ";
    }
    rows.push(row);
  }
  return rows;
}

export const WORDMARK_HEIGHT = 4;

/** The wordmark's lines (all the same width). */
export function wordmark(): Line[] {
  const letters = Array.from(WORD).map(cells);
  const out: Line[] = [];
  for (let r = 0; r < WORDMARK_HEIGHT; r++) {
    const first = letters.slice(0, SPLIT).map((l) => l[r]).join(" ");
    const second = letters.slice(SPLIT).map((l) => l[r]).join(" ");
    out.push([span(first, fg("muted")), span(" "), span(second, fg("accent"))]);
  }
  return out;
}

export const WORDMARK_WIDTH = Array.from(WORD).reduce((n, l) => n + LETTERS[l]![0]!.length, 0) + WORD.length - 1;
