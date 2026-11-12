/**
 * How wide text is on a terminal, as the Markdown renderer asks it.
 *
 * The screen part owns the real answer (`src/tui/full/screen/width.ts`: East Asian wide characters, emoji, joiners,
 * variation selectors). The renderer takes it through this small interface so a test can hand in a simple stand-in
 * and so nothing here guesses differently from what the screen will draw.
 */
import { displayWidth, graphemes } from "../full/screen/width.js";

export interface Measure {
  /** Cells the text takes. The text is clean: no controls, no newlines, no tabs. */
  displayWidth(text: string): number;
  /** The text split into user-perceived characters, never splitting one. */
  graphemes(text: string): string[];
}

/** The screen's own measure: what every caller outside the tests uses. */
export const screenMeasure: Measure = { displayWidth, graphemes };

const PRINTABLE_ASCII = /^[\x20-\x7e]*$/;

/**
 * A measure with fast paths for the common case (printable ASCII is one cell per character), so a long plain line
 * never pays for grapheme segmentation.
 */
export class Measurer {
  constructor(readonly measure: Measure) {}

  width(text: string): number {
    if (text.length === 0) return 0;
    if (PRINTABLE_ASCII.test(text)) return text.length;
    return this.measure.displayWidth(text);
  }

  graphemes(text: string): string[] {
    if (PRINTABLE_ASCII.test(text)) return text.split("");
    return this.measure.graphemes(text);
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
