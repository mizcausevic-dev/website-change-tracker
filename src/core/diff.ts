import { diffArrays, diffWordsWithSpace } from 'diff';

export type Segment = { op: 'eq' | 'add' | 'del'; text: string };
export type DiffLine =
  | { op: 'ctx'; text: string; old: number; new: number }
  | { op: 'del'; text: string; old: number; segments?: Segment[] }
  | { op: 'add'; text: string; new: number; segments?: Segment[] };
export interface Hunk {
  old_start: number;
  old_lines: number;
  new_start: number;
  new_lines: number;
  lines: DiffLine[];
}
export interface DiffResult {
  hunks: Hunk[];
  wordsAdded: number;
  wordsRemoved: number;
  linesAdded: string[];
  linesRemoved: string[];
  /** Lines inserted or deleted outright (not edits of an existing line). */
  pureAdded: string[];
  pureRemoved: string[];
  /** In-place edits as [before, after] pairs. */
  edits: Array<[string, string]>;
  headingsTouched: string[];
}

const words = (s: string): number => (s.trim() ? s.trim().split(/\s+/).length : 0);

/**
 * Line diff (Myers, via jsdiff) with a word-level diff for each replaced line.
 * Replaced lines are paired positionally inside a del/add block, which matches
 * how editors usually modify a page: one paragraph edited in place.
 */
export function diffText(oldText: string, newText: string, context = 3): DiffResult {
  const a = oldText ? oldText.split('\n') : [];
  const b = newText ? newText.split('\n') : [];
  const parts = diffArrays(a, b);

  const flat: DiffLine[] = [];
  let oldNo = 1;
  let newNo = 1;
  let wordsAdded = 0;
  let wordsRemoved = 0;
  const linesAdded: string[] = [];
  const linesRemoved: string[] = [];
  const pureAdded: string[] = [];
  const pureRemoved: string[] = [];
  const edits: Array<[string, string]> = [];

  for (let i = 0; i < parts.length; i++) {
    const part = parts[i]!;
    if (!part.added && !part.removed) {
      for (const text of part.value) flat.push({ op: 'ctx', text, old: oldNo++, new: newNo++ });
      continue;
    }
    if (part.removed) {
      const next = parts[i + 1];
      const removed = part.value;
      const added = next?.added ? next.value : [];
      if (next?.added) i++;
      const paired = Math.min(removed.length, added.length);
      const dels: DiffLine[] = [];
      const adds: DiffLine[] = [];
      for (let k = 0; k < removed.length; k++) {
        const text = removed[k]!;
        linesRemoved.push(text);
        if (k < paired) {
          const segs = diffWordsWithSpace(text, added[k]!);
          const delSegs: Segment[] = [];
          const addSegs: Segment[] = [];
          for (const s of segs) {
            if (s.added) {
              addSegs.push({ op: 'add', text: s.value });
              wordsAdded += words(s.value);
            } else if (s.removed) {
              delSegs.push({ op: 'del', text: s.value });
              wordsRemoved += words(s.value);
            } else {
              delSegs.push({ op: 'eq', text: s.value });
              addSegs.push({ op: 'eq', text: s.value });
            }
          }
          dels.push({ op: 'del', text, old: oldNo++, segments: delSegs });
          adds.push({ op: 'add', text: added[k]!, new: newNo++, segments: addSegs });
          linesAdded.push(added[k]!);
          edits.push([text, added[k]!]);
        } else {
          pureRemoved.push(text);
          wordsRemoved += words(text);
          dels.push({ op: 'del', text, old: oldNo++ });
        }
      }
      for (let k = paired; k < added.length; k++) {
        wordsAdded += words(added[k]!);
        linesAdded.push(added[k]!);
        pureAdded.push(added[k]!);
        adds.push({ op: 'add', text: added[k]!, new: newNo++ });
      }
      flat.push(...dels, ...adds);
      continue;
    }
    // A pure insertion (no preceding removal).
    for (const text of part.value) {
      wordsAdded += words(text);
      linesAdded.push(text);
      pureAdded.push(text);
      flat.push({ op: 'add', text, new: newNo++ });
    }
  }

  // Group into hunks with `context` lines around each change.
  const hunks: Hunk[] = [];
  const changedIdx = flat.map((l, i) => (l.op === 'ctx' ? -1 : i)).filter((i) => i >= 0);
  let cursor = 0;
  while (cursor < changedIdx.length) {
    const first = changedIdx[cursor]!;
    let last = first;
    while (cursor + 1 < changedIdx.length && changedIdx[cursor + 1]! - last <= context * 2 + 1) {
      cursor++;
      last = changedIdx[cursor]!;
    }
    cursor++;
    const start = Math.max(0, first - context);
    const end = Math.min(flat.length - 1, last + context);
    const lines = flat.slice(start, end + 1);
    const firstOld = lines.find((l) => l.op !== 'add') as { old: number } | undefined;
    const firstNew = lines.find((l) => l.op !== 'del') as { new: number } | undefined;
    hunks.push({
      old_start: firstOld?.old ?? 0,
      old_lines: lines.filter((l) => l.op !== 'add').length,
      new_start: firstNew?.new ?? 0,
      new_lines: lines.filter((l) => l.op !== 'del').length,
      lines,
    });
  }

  // Which sections changed: nearest heading above each changed line.
  const headingsTouched = new Set<string>();
  let heading = '';
  for (const l of flat) {
    const h = /^#{1,6} (.*)$/.exec(l.text);
    if (h && l.op !== 'del') heading = h[1] ?? '';
    if (l.op !== 'ctx') headingsTouched.add(h ? (h[1] ?? '') : heading || '(top of page)');
  }

  return { hunks, wordsAdded, wordsRemoved, linesAdded, linesRemoved, pureAdded, pureRemoved, edits, headingsTouched: [...headingsTouched].slice(0, 8) };
}

/** Render stored hunks as a unified diff (served for `Accept: text/x-diff`). */
export function toUnified(hunks: Hunk[], oldLabel: string, newLabel: string): string {
  const out = [`--- ${oldLabel}`, `+++ ${newLabel}`];
  for (const h of hunks) {
    out.push(`@@ -${h.old_start},${h.old_lines} +${h.new_start},${h.new_lines} @@`);
    for (const l of h.lines) out.push(`${l.op === 'add' ? '+' : l.op === 'del' ? '-' : ' '}${l.text}`);
  }
  return out.join('\n') + '\n';
}
