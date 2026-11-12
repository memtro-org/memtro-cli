import type { Mode } from "../agent/types.js";
import type { Style } from "./style.js";

/** What the line after each turn reports. Pure inputs, so the line is tested as text. */
export interface TurnStats {
  /** The model Memtro says answered (from `routing`), else the one asked for. */
  model: string;
  /** Input plus output tokens over every step of the turn; null when no step reported usage. */
  tokens: number | null;
  contextUsed: number | null;
  contextLimit: number | null;
  mode: Mode;
}

export function compactNumber(n: number): string {
  if (n < 1000) return String(n);
  if (n < 10_000) return `${(n / 1000).toFixed(1).replace(/\.0$/, "")}k`;
  if (n < 1_000_000) return `${Math.round(n / 1000)}k`;
  return `${(n / 1_000_000).toFixed(1).replace(/\.0$/, "")}M`;
}

/** "anthropic/claude-sonnet-5 · 12k tokens · 41% of context · auto". Unknowns are said, never guessed. */
export function statusLine(s: TurnStats, st: Style): string {
  const parts = [s.model];
  parts.push(s.tokens === null ? "tokens not reported" : `${compactNumber(s.tokens)} tokens`);
  if (s.contextUsed !== null && s.contextLimit) {
    const pct = Math.min(100, Math.round((s.contextUsed / s.contextLimit) * 100));
    const text = `${pct}% of context`;
    parts.push(pct >= 80 ? st.yellow(text) : text);
  } else if (s.contextUsed !== null) {
    parts.push(`${compactNumber(s.contextUsed)} context (limit unknown)`);
  }
  parts.push(s.mode === "unchecked" ? st.red("unchecked") : s.mode);
  return st.dim(parts.join(" · "));
}
