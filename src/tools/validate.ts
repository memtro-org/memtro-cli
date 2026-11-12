/**
 * Hand-written argument checks, one per field, against the tool's own JSON Schema. Each returns the value or
 * throws `ArgError` with a sentence the model can act on; `validated` turns that into the contract's result.
 * Unknown extra fields are ignored, as the schemas' `additionalProperties` default allows.
 */

export class ArgError extends Error {}

export type Fields = Record<string, unknown>;

export function validated<A>(raw: unknown, build: (o: Fields) => A): { ok: true; args: A } | { ok: false; error: string } {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { ok: false, error: "Arguments must be a JSON object." };
  try {
    return { ok: true, args: build(raw as Fields) };
  } catch (err) {
    if (err instanceof ArgError) return { ok: false, error: err.message };
    throw err;
  }
}

export function str(o: Fields, key: string, opts: { required: true; nonEmpty?: boolean }): string;
export function str(o: Fields, key: string, opts?: { required?: false; nonEmpty?: boolean }): string | undefined;
export function str(o: Fields, key: string, opts: { required?: boolean; nonEmpty?: boolean } = {}): string | undefined {
  const v = o[key];
  if (v === undefined || v === null) {
    if (opts.required) throw new ArgError(`"${key}" is required (a string).`);
    return undefined;
  }
  if (typeof v !== "string") throw new ArgError(`"${key}" must be a string, not ${describe(v)}.`);
  if (opts.nonEmpty && v.length === 0) throw new ArgError(`"${key}" must not be empty.`);
  return v;
}

export function int(o: Fields, key: string, opts: { min: number; max: number }): number | undefined {
  const v = o[key];
  if (v === undefined || v === null) return undefined;
  if (typeof v !== "number" || !Number.isInteger(v)) throw new ArgError(`"${key}" must be a whole number, not ${describe(v)}.`);
  if (v < opts.min || v > opts.max) throw new ArgError(`"${key}" must be between ${opts.min} and ${opts.max}; got ${v}.`);
  return v;
}

export function bool(o: Fields, key: string): boolean | undefined {
  const v = o[key];
  if (v === undefined || v === null) return undefined;
  if (typeof v !== "boolean") throw new ArgError(`"${key}" must be true or false, not ${describe(v)}.`);
  return v;
}

export function describe(v: unknown): string {
  if (v === null) return "null";
  if (Array.isArray(v)) return "an array";
  if (typeof v === "string") return "a string";
  if (typeof v === "number") return `the number ${v}`;
  return `a ${typeof v}`;
}
