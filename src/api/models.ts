import type { ApiClient } from "./client.js";

/**
 * `GET /v1/models` (brain src/app/v1/models/route.ts): `{object: "list", data: [{id, limit?: {context, output}}]}`.
 * `limit` is left out when the platform does not know it, so null here means "unknown", never "unlimited".
 *
 * Under the routing lock (the default for every organisation, brain routing/router.ts `underModelLock`) the list
 * holds only `memtro`, `auto` and `auto/<provider>`, and any other id sent is silently answered by `memtro`.
 */

export interface ModelInfo {
  id: string;
  context: number | null;
  output: number | null;
}

interface ModelRow {
  id?: unknown;
  limit?: { context?: unknown; output?: unknown } | null;
}

const positive = (n: unknown): number | null => (typeof n === "number" && Number.isFinite(n) && n > 0 ? n : null);

export async function listModels(client: ApiClient): Promise<ModelInfo[]> {
  const body = await client.json<{ data?: ModelRow[] }>("/v1/models");
  return parseModels(body);
}

/** Pure: the rows of a `/v1/models` body, skipping anything without a string id. */
export function parseModels(body: unknown): ModelInfo[] {
  const rows = (body as { data?: unknown } | null)?.data;
  if (!Array.isArray(rows)) return [];
  const out: ModelInfo[] = [];
  for (const row of rows as ModelRow[]) {
    if (typeof row?.id !== "string" || !row.id) continue;
    out.push({ id: row.id, context: positive(row.limit?.context), output: positive(row.limit?.output) });
  }
  return out;
}

/** `memtro`, `auto` and `auto/<provider>`: the ids that are always offered and always routed. */
export const isRoutedId = (id: string): boolean => /^(memtro|auto)(\/[^:]*)?$/.test(bareModelId(id));

/** The id without a `:chat`/`:agent` suffix (brain compat.ts `splitMode`). */
export const bareModelId = (id: string): string => id.trim().replace(/:(agent|chat)$/, "");

/**
 * Whether naming an explicit model does anything. The platform lists explicit ids only when the routing lock is
 * off for this principal (facts A6/F1), so one explicit id in the list is the evidence; none means the lock.
 */
export function explicitModelsUsable(models: ModelInfo[]): boolean {
  return models.some((m) => !isRoutedId(m.id));
}

/**
 * The small, fast models of the default ladders (brain routing/ladders.ts `DEFAULT_LADDERS`, cheapest rung
 * first), as patterns so a dated or re-versioned id still matches. Earlier is preferred.
 */
const CHEAP_PATTERNS: RegExp[] = [
  /^anthropic\/claude-haiku-[\w.-]+$/,
  /^openai\/gpt-[\d.]+-nano$/,
  /^google\/gemini-[\d.]+-flash-lite$/,
  /^openai\/gpt-[\d.]+-mini$/,
  /^google\/gemini-[\d.]+-flash$/,
];

/**
 * The cheapest explicit model the harness recognises in this account's list, as listed (no suffix: whoever
 * sends it adds `:chat`, as `streamTurn` and `forcedCallVia` do), or null. Null as well under the routing lock,
 * where an explicit id would be answered by `memtro` anyway.
 */
export function cheapestKnownModel(models: ModelInfo[]): string | null {
  if (!explicitModelsUsable(models)) return null;
  for (const pattern of CHEAP_PATTERNS) {
    // Among several matches (two Haiku versions), the newest-looking id: the higher version sorts later.
    const matches = models.map((m) => bareModelId(m.id)).filter((id) => pattern.test(id));
    if (matches.length) return matches.sort((a, b) => a.localeCompare(b, "en", { numeric: true })).at(-1)!;
  }
  return null;
}

/**
 * A `contextLimit` for `createAgent`: the listed `limit.context` of the model asked for, suffix ignored. Null when
 * the model is not listed or its limit is unknown, which turns automatic compaction off rather than guessing.
 */
export function contextLimitFrom(models: ModelInfo[]): (model: string) => number | null {
  const byId = new Map(models.map((m) => [m.id, m.context]));
  return (model) => byId.get(bareModelId(model)) ?? null;
}
