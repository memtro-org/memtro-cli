import type { Editor, EditResult } from "../editor.js";
import type { Input, Line } from "../types.js";

/** The application's few uses of S's `Editor`, in one place. */

export function editorView(editor: Editor, width: number): { lines: Line[]; cursor: { x: number; y: number } } {
  const v = editor.lines(width);
  return v.lines.length ? v : { lines: [[]], cursor: v.cursor };
}

export function editorHandle(editor: Editor, input: Input): EditResult {
  return editor.handle(input);
}

export function editorSetText(editor: Editor, text: string): void {
  if (text) editor.setText(text);
  else editor.clear();
}

/** What Enter sends: the text, remembered in the history when it qualifies, and the editor cleared. */
export function editorTake(editor: Editor): string {
  return editor.take();
}
