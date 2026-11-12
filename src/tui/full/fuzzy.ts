/**
 * Fuzzy matching for menus and the palette.
 *
 * The query's characters must appear in order (a subsequence), ignoring case. Among the ways they can appear, the
 * best one is chosen: a match at the start of the text, at the start of a word (after a space, `/`, `-`, `_`, `.`,
 * `:` or at a lower-to-upper case change) and in a contiguous run scores higher; gaps cost a little. Items whose
 * primary key matches always rank before items that match only on the secondary key; then by score; then
 * alphabetically by primary key; then in the order given.
 *
 * Cost: O(text × query) per item, with the query capped at 64 characters, so it stays linear in the number of
 * items and their length. An empty query returns everything in the given order.
 */

export interface FuzzyResult<T> {
  item: T;
  score: number;
  /** Indices (UTF-16) of the matched characters in the key that matched. */
  positions: number[];
  /** Which key the positions refer to. */
  on: "primary" | "secondary";
}

const MAX_QUERY = 64;
/** Beyond this many cells of work an item is matched greedily instead (still correct, less carefully scored). */
const MAX_WORK = 200_000;

const SCORE_MATCH = 16;
const BONUS_START = 24;
const BONUS_BOUNDARY = 20;
const BONUS_CAMEL = 14;
const BONUS_CONSECUTIVE = 18;
/** A gap costs this much to open and PENALTY_GAP for each further character. */
const PENALTY_GAP_START = 6;
const PENALTY_GAP = 1;
const PENALTY_LEADING = 1;
const MAX_LEADING_PENALTY = 12;

const SEPARATORS = new Set([" ", "/", "\\", "-", "_", ".", ":", ",", "(", "[", "@", "#", "'", '"']);

function bonusAt(text: string, i: number): number {
  if (i === 0) return BONUS_START;
  const prev = text[i - 1]!;
  if (SEPARATORS.has(prev)) return BONUS_BOUNDARY;
  const cur = text[i]!;
  if (prev >= "a" && prev <= "z" && cur >= "A" && cur <= "Z") return BONUS_CAMEL;
  if (!(prev >= "0" && prev <= "9") && cur >= "0" && cur <= "9") return BONUS_CAMEL / 2;
  return 0;
}

/** The best match of `q` (already lower case) in `text`, or null. */
export function fuzzyMatch(text: string, query: string): { score: number; positions: number[] } | null {
  const q = query.toLowerCase().slice(0, MAX_QUERY);
  if (!q) return { score: 0, positions: [] };
  const lower = text.toLowerCase();
  // lower-casing can change length for a few scripts; fall back to the original text then
  const t = lower.length === text.length ? lower : text;
  const n = t.length;
  const m = q.length;
  // Quick reject and the span the match can live in.
  let first = -1;
  let qi = 0;
  for (let i = 0; i < n && qi < m; i++) {
    if (t[i] === q[qi]) {
      if (qi === 0) first = i;
      qi++;
    }
  }
  if (qi < m) return null;
  if (n * m > MAX_WORK) return greedy(text, t, q, first);

  // DP over (query index j, text index i): best score with q[j] matched at i, and whether it continued a run.
  const NEG = -1e9;
  const score: Float64Array[] = [];
  const from: Int32Array[] = [];
  for (let j = 0; j < m; j++) {
    const row = new Float64Array(n).fill(NEG);
    const back = new Int32Array(n).fill(-1);
    // best (score of previous row at k) + gap penalty, maintained as a running max over k < i
    let bestPrev = NEG;
    let bestPrevAt = -1;
    for (let i = 0; i < n; i++) {
      if (j > 0 && i > 0) {
        // candidate: previous match at i-1 (consecutive) is handled below; non-consecutive k < i-1 via running max
        const k = i - 2;
        if (k >= 0) {
          const s = score[j - 1]![k]!;
          // penalise by distance lazily: decay the running best by the gap penalty as i moves on
          const opened = s - PENALTY_GAP_START + PENALTY_GAP;
          if (s > NEG / 2 && opened >= bestPrev) {
            bestPrev = opened;
            bestPrevAt = k;
          }
        }
        if (bestPrev > NEG / 2) bestPrev -= PENALTY_GAP;
      }
      if (t[i] !== q[j]) continue;
      const b = bonusAt(text, i);
      if (j === 0) {
        row[i] = SCORE_MATCH + b - Math.min(MAX_LEADING_PENALTY, i * PENALTY_LEADING);
        continue;
      }
      let best = NEG;
      let at = -1;
      const prevConsecutive = i > 0 ? score[j - 1]![i - 1]! : NEG;
      if (prevConsecutive > NEG / 2) {
        best = prevConsecutive + SCORE_MATCH + Math.max(b, BONUS_CONSECUTIVE);
        at = i - 1;
      }
      if (bestPrev > NEG / 2 && bestPrev + SCORE_MATCH + b > best) {
        best = bestPrev + SCORE_MATCH + b;
        at = bestPrevAt;
      }
      row[i] = best;
      back[i] = at;
    }
    score.push(row);
    from.push(back);
  }
  let end = -1;
  let top = NEG;
  const last = score[m - 1]!;
  for (let i = 0; i < n; i++) {
    if (last[i]! > top) {
      top = last[i]!;
      end = i;
    }
  }
  if (end < 0) return null;
  const positions: number[] = new Array(m);
  let i = end;
  for (let j = m - 1; j >= 0; j--) {
    positions[j] = i;
    i = from[j]![i]!;
  }
  return { score: top, positions };
}

/** Earliest-then-tightened match for very long texts: linear. */
function greedy(text: string, t: string, q: string, first: number): { score: number; positions: number[] } {
  const positions: number[] = [];
  let qi = 0;
  for (let i = first; i < t.length && qi < q.length; i++) {
    if (t[i] === q[qi]) {
      positions.push(i);
      qi++;
    }
  }
  let score = 0;
  positions.forEach((p, k) => {
    score += SCORE_MATCH + bonusAt(text, p);
    if (k > 0) score += p === positions[k - 1]! + 1 ? BONUS_CONSECUTIVE : -PENALTY_GAP_START - PENALTY_GAP * Math.min(50, p - positions[k - 1]! - 2);
  });
  score -= Math.min(MAX_LEADING_PENALTY, first * PENALTY_LEADING);
  return { score, positions };
}

export function fuzzyFilter<T>(items: T[], query: string, keys: (item: T) => { primary: string; secondary?: string }): FuzzyResult<T>[] {
  const q = query.trim();
  if (!q) return items.map((item) => ({ item, score: 0, positions: [], on: "primary" as const }));
  const scored: Array<FuzzyResult<T> & { tier: number; name: string; index: number }> = [];
  items.forEach((item, index) => {
    const k = keys(item);
    const p = fuzzyMatch(k.primary, q);
    if (p) {
      scored.push({ item, score: p.score, positions: p.positions, on: "primary", tier: 0, name: k.primary.toLowerCase(), index });
      return;
    }
    if (k.secondary) {
      const s = fuzzyMatch(k.secondary, q);
      if (s) scored.push({ item, score: s.score, positions: s.positions, on: "secondary", tier: 1, name: k.primary.toLowerCase(), index });
    }
  });
  scored.sort((a, b) => a.tier - b.tier || b.score - a.score || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0) || a.index - b.index);
  return scored.map(({ item, score, positions, on }) => ({ item, score, positions, on }));
}
