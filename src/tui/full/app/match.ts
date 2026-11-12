import { fuzzyFilter } from "../fuzzy.js";

/**
 * Fuzzy matching for the menus and dialogs through S's `fuzzyFilter`, which ranks as the spec puts it: matches on
 * the primary text first, then by score, ties alphabetical. An empty query keeps every item, in alphabetical order
 * when `sortEmpty` is set and in the order given otherwise.
 */
export interface Ranked<T> {
  item: T;
  /** UTF-16 indices matched in the primary text, for highlighting; empty for a match on the secondary text. */
  positions: number[];
}

export function rank<T>(items: readonly T[], query: string, primary: (t: T) => string, secondary?: (t: T) => string, o: { sortEmpty?: boolean } = {}): Ranked<T>[] {
  if (!query.trim()) {
    const all = items.map((item) => ({ item, positions: [] as number[] }));
    return o.sortEmpty ? all.sort((a, b) => cmp(primary(a.item), primary(b.item))) : all;
  }
  return fuzzyFilter([...items], query, (t) => (secondary ? { primary: primary(t), secondary: secondary(t) } : { primary: primary(t) })).map((r) => ({
    item: r.item,
    positions: r.on === "primary" ? r.positions : [],
  }));
}

const cmp = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
