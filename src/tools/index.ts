import type { Tool } from "../agent/types.js";
import { bashTool } from "./bash.js";
import { editTool } from "./edit.js";
import { globTool } from "./glob.js";
import { grepTool } from "./grep.js";
import { listTool } from "./list.js";
import { readTool } from "./read.js";
import { ReadLedger } from "./read-ledger.js";
import { writeTool } from "./write.js";

export { LOCAL_TOOL_NAMES } from "./names.js";
export { loadMemtroTools } from "./memtro.js";

/**
 * The tools that touch this computer: read, list, glob, grep, edit, write, bash.
 *
 * Call once per session. The tools made by one call share one read ledger, which is what lets `edit` and `write`
 * insist the file was read first; two sessions never see each other's reads.
 */
export function createLocalTools(): Tool[] {
  const ledger = new ReadLedger();
  // Each tool is typed by its own arguments; the loop validates before it calls, so the widening is safe.
  return [readTool(ledger), listTool(), globTool(), grepTool(), editTool(ledger), writeTool(ledger), bashTool()] as unknown as Tool[];
}
