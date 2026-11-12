/**
 * How wide text is on a terminal, as the Markdown renderer asks it.
 *
 * The screen part owns the real answer (`src/tui/full/screen/width.ts`: East Asian wide characters, emoji, joiners,
 * variation selectors). The renderer takes it through this small interface so a test can hand in a simple stand-in
 * and so nothing here guesses differently from what the screen will draw.
 */
import { displayWidth, graphemes, graphemeWidth } from "../full/screen/width.js";

export interface Measure {
  /** Cells the text takes. The text is clean: no controls, no newlines, no tabs. */
  displayWidth(text: string): number;
  /** The text split into user-perceived characters, never splitting one. */
  graphemes(text: string): string[];
  /**
   * Cells one grapheme (as `graphemes` returned it) takes. Optional: without it `displayWidth` is asked, which
   * segments the text again. The screen's measure has it, so wrapping a long non-ASCII run costs one segmentation,
   * not one per character.
   */
  graphemeWidth?(grapheme: string): number;
}

/** The screen's own measure: what every caller outside the tests uses. */
export const screenMeasure: Measure = { displayWidth, graphemes, graphemeWidth };

const PRINTABLE_ASCII = /^[\x20-\x7e]*$/;

/**
 * A measure with fast paths for the common case (printable ASCII is one cell per character), so a long plain line
 * never pays for grapheme segmentation.
 */
export class Measurer {
  constructor(readonly measure: Measure) {}

  /** Widths of short non-ASCII strings already measured: borders, bullets and quote bars repeat on every line. */
  private readonly known = new Map<string, number>();

  width(text: string): number {
    if (text.length === 0) return 0;
    if (PRINTABLE_ASCII.test(text)) return text.length;
    if (text.length > 256) return this.measure.displayWidth(text);
    let w = this.known.get(text);
    if (w === undefined) {
      w = this.measure.displayWidth(text);
      if (this.known.size >= 4096) this.known.clear();
      this.known.set(text, w);
    }
    return w;
  }

  graphemes(text: string): string[] {
    if (PRINTABLE_ASCII.test(text)) return text.split("");
    return this.measure.graphemes(text);
  }

  /** Cells one grapheme takes; `g` must be a single grapheme from `graphemes`. */
  cell(g: string): number {
    if (g.length === 1) {
      const c = g.charCodeAt(0);
      if (c >= 0x20 && c < 0x7f) return 1;
    }
    return this.measure.graphemeWidth ? this.measure.graphemeWidth(g) : this.measure.displayWidth(g);
  }
}

let cached: Measurer | null = null;
let cachedFor: Measure | null = null;

export function measurer(measure: Measure | undefined): Measurer {
  const m = measure ?? screenMeasure;
  if (cached && cachedFor === m) return cached;
  cached = new Measurer(m);
  cachedFor = m;
  return cached;
}
