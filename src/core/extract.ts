import { createHash } from 'node:crypto';
import { parse, NodeType, type HTMLElement, type Node } from 'node-html-parser';

/**
 * HTML -> normalized, line-oriented text.
 *
 * "Meaningful change" detection lives or dies here. Raw HTML changes on every
 * request (CSRF tokens, cache-busting asset hashes, rotating ads), so diffing
 * markup produces noise. We reduce the page to the text a reader sees, keep
 * enough structure (headings, list items, table rows) for diffs to be readable,
 * then mask volatile tokens such as relative times and session IDs.
 */

const DROP_TAGS = new Set(['script', 'style', 'noscript', 'template', 'svg', 'iframe', 'canvas', 'head', 'object', 'embed', 'select', 'button']);
const BLOCK_TAGS = new Set([
  'address', 'article', 'aside', 'blockquote', 'body', 'dd', 'details', 'div', 'dl', 'dt', 'fieldset', 'figcaption',
  'figure', 'footer', 'form', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'header', 'hr', 'li', 'main', 'nav', 'ol', 'p',
  'pre', 'section', 'summary', 'table', 'tbody', 'thead', 'tfoot', 'tr', 'ul', 'br', 'caption', 'label',
]);
const CELL_TAGS = new Set(['td', 'th']);

const MAX_LINE = 2000;
const MAX_LINES = 20000;

export interface ExtractOptions {
  selector?: string | null;
  ignoreSelectors?: string[];
  ignorePatterns?: string[];
}

export interface Fact {
  key: string;
  value: number;
  currency: 'USD' | 'EUR' | 'GBP';
  raw: string;
}

export interface Extraction {
  /** Text after structure extraction but before noise masking. */
  rawText: string;
  /** Text after noise masking. This is what gets hashed, stored and diffed. */
  text: string;
  rawHash: string;
  hash: string;
  wordCount: number;
  facts: Fact[];
  /** Which built-in noise filters fired, with counts. Useful for explaining "noise" outcomes. */
  maskedTokens: Record<string, number>;
  selectorMatched: boolean;
}

export const sha256 = (s: string): string => createHash('sha256').update(s).digest('hex');

function collapse(s: string): string {
  return s.replace(/[\s ​]+/g, ' ').trim();
}

function tagOf(node: HTMLElement): string {
  return (node.rawTagName ?? '').toLowerCase();
}

function walk(root: HTMLElement): string[] {
  const lines: string[] = [];
  let current = '';
  let prefix = '';

  const flush = (): void => {
    const text = collapse(current);
    if (text) lines.push((prefix + text).slice(0, MAX_LINE));
    current = '';
    prefix = '';
  };

  const visit = (node: Node): void => {
    if (lines.length >= MAX_LINES) return;
    if (node.nodeType === NodeType.TEXT_NODE) {
      current += node.text;
      return;
    }
    if (node.nodeType !== NodeType.ELEMENT_NODE) return;
    const el = node as HTMLElement;
    const tag = tagOf(el);
    if (DROP_TAGS.has(tag)) return;
    if (el.getAttribute('hidden') !== undefined || el.getAttribute('aria-hidden') === 'true') return;
    if (tag === 'input' || tag === 'img') {
      const alt = tag === 'img' ? el.getAttribute('alt') : undefined;
      if (alt) current += ` ${alt} `;
      return;
    }
    if (CELL_TAGS.has(tag)) {
      if (collapse(current)) current += ' | ';
      for (const child of el.childNodes) visit(child);
      return;
    }
    const block = BLOCK_TAGS.has(tag);
    if (block) flush();
    const heading = /^h([1-6])$/.exec(tag);
    if (heading) prefix = `${'#'.repeat(Number(heading[1]))} `;
    else if (tag === 'li') prefix = '- ';
    for (const child of el.childNodes) visit(child);
    if (block) flush();
  };

  visit(root);
  flush();
  return lines;
}

// Built-in volatile-token masks. Each is anchored on context words so that a
// real content change ("deleted within 30 days" -> "90 days") is never masked.
//
// These run on page text that the tracked site controls, so every quantifier that can repeat
// is bounded and no pattern rescans a run from each position: each stays linear in line length.
// (An earlier opaque-token rule used lookaheads that rescanned the run at every word boundary,
// and the counter rule had an unbounded number match that backtracked; both were quadratic.)
const NOISE_FILTERS: Array<{ name: string; re: RegExp; token: string; accept?: (m: string) => boolean }> = [
  { name: 'iso_timestamp', re: /\b\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d{1,9})?)?(?:Z|[+-]\d{2}:?\d{2})?/g, token: '{timestamp}' },
  { name: 'clock_time', re: /\b\d{1,2}:\d{2}(?::\d{2})?\s?(?:AM|PM|UTC|GMT)\b/gi, token: '{time}' },
  { name: 'relative_time', re: /\b(?:\d{1,4}|an?|one)\s{1,3}(?:second|sec|minute|min|hour|hr|day|week)s?\s{1,3}ago\b|\bjust now\b/gi, token: '{ago}' },
  { name: 'countdown', re: /\b(?:ends|expires|starts|closes|resets)\s{1,3}in\s{1,3}\d{1,4}\s{0,3}(?:s|secs?|seconds?|m|mins?|minutes?|h|hrs?|hours?|d|days?)\b/gi, token: '{countdown}' },
  { name: 'engagement_count', re: /\b\d[\d,.]{0,15}\s{0,3}(?:k\s{1,3})?(?:views|reads|votes|likes|comments|shares|people (?:viewing|watching)|readers online)\b/gi, token: '{count}' },
  { name: 'hex_token', re: /\b[0-9a-f]{16,}\b/gi, token: '{token}' },
  // Maximal runs of token characters; the digit-and-letter test happens outside the regex.
  { name: 'opaque_token', re: /[A-Za-z0-9_-]{24,}/g, token: '{token}', accept: (m) => /\d/.test(m) && /[A-Za-z]/.test(m) },
];

/**
 * User-supplied ignore patterns: literal text where `*` matches up to WILDCARD_GAP characters
 * within one line, case-insensitive, shortest match.
 *
 * These are matched with a plain scanner, not a regular expression. An earlier version compiled
 * each `*` to `[^\n]{0,400}?` and ran it on V8's backtracking engine; stacked wildcards made that
 * polynomial (`a*a*a*b` against 2,000 characters ran for over 20 s). The scanner looks for each
 * literal segment with `indexOf` inside a bounded window. The window searches are the only part
 * whose cost can multiply, so the characters they examine are charged to a per-page budget, and
 * the worst case is capped no matter what pattern or page text an attacker controls.
 */
export const WILDCARD_GAP = 400;
export const IGNORE_PATTERN_BUDGET = 20_000_000;

export interface ScanBudget {
  left: number;
}

export interface CompiledPattern {
  segments: string[];
  /** A leading `*` lets a match begin up to WILDCARD_GAP characters before the first segment. */
  leading: boolean;
}

/**
 * U+0130 (capital I with dot) is the one code point whose lowercase form is longer than itself,
 * which would shift every later position; fold it to a plain I first so offsets stay aligned.
 */
const fold = (s: string): string => s.replace(/İ/g, 'I').toLowerCase();

export function compileIgnorePattern(pattern: string): CompiledPattern {
  return { segments: fold(pattern).split('*').filter((x) => x.length > 0), leading: pattern.startsWith('*') };
}

/**
 * Remove every non-overlapping match of `pattern` from `line`. Returns null if the budget ran out.
 *
 * Semantics: each segment is taken at its earliest occurrence within WILDCARD_GAP characters after
 * the previous one. Unlike a backtracking regex, it does not retry later occurrences of a middle
 * segment when a later segment is out of range; that is the trade that keeps it linear.
 *
 * Cost: finding the first segment is a forward `indexOf` scan, linear per line. Only the bounded
 * windows searched for later segments can multiply, so only characters examined there are charged.
 */
export function stripWildcardMatches(line: string, pattern: CompiledPattern, budget: ScanBudget): { out: string; hits: number } | null {
  const { segments, leading } = pattern;
  if (!segments.length) return { out: line, hits: 0 };
  const folded = fold(line);
  // If lowercasing still changed the length, positions would not line up; skip rather than mis-cut.
  if (folded.length !== line.length) return { out: line, hits: 0 };
  const first = segments[0]!;
  let out = '';
  let kept = 0;
  let from = 0;
  let hits = 0;
  while (from < folded.length) {
    const start = folded.indexOf(first, from);
    if (start < 0) break;
    let end = start + first.length;
    let matched = true;
    for (let k = 1; k < segments.length; k++) {
      const seg = segments[k]!;
      const window = folded.slice(end, end + WILDCARD_GAP + seg.length);
      const at = window.indexOf(seg);
      budget.left -= at < 0 ? window.length : at + seg.length;
      if (budget.left < 0) return null;
      if (at < 0) {
        matched = false;
        break;
      }
      end += at + seg.length;
    }
    if (matched) {
      const matchStart = leading ? Math.max(kept, start - WILDCARD_GAP) : start;
      out += line.slice(kept, matchStart);
      kept = end;
      hits++;
      from = end;
    } else {
      from = start + 1;
    }
  }
  return { out: out + line.slice(kept), hits };
}

const PRICE_RE = /([$€£])\s?(\d{1,3}(?:,\d{3})+(?:\.\d{1,2})?|\d+(?:\.\d{1,2})?)/g;
const CURRENCY: Record<string, Fact['currency']> = { $: 'USD', '€': 'EUR', '£': 'GBP' };

// Label context is read from a bounded window around each price, and the facts list is capped:
// page text is attacker-controlled, and a line full of prices must not cost O(n^2) or bloat storage.
const FACT_CONTEXT = 200;
const MAX_FACTS = 100;
const LABEL_TRIM = new Set([' ', '\t', ':', '|', '—', '–', '-', '·', ',', '(']);

/** Strip trailing separator characters with a plain loop (an anchored-at-end regex here was quadratic). */
function trimTrailing(s: string): string {
  let end = s.length;
  while (end > 0 && (LABEL_TRIM.has(s[end - 1]!) || /\s/.test(s[end - 1]!))) end--;
  return s.slice(0, end);
}

function extractFacts(lines: string[]): Fact[] {
  const facts: Fact[] = [];
  const seen = new Map<string, number>();
  let heading = '';
  for (const line of lines) {
    if (facts.length >= MAX_FACTS) break;
    const h = /^#{1,6} (.*)$/.exec(line);
    if (h) {
      heading = (h[1] ?? '').slice(0, 40);
      continue;
    }
    for (const m of line.matchAll(PRICE_RE)) {
      if (facts.length >= MAX_FACTS) break;
      const idx = m.index ?? 0;
      const lead = idx <= FACT_CONTEXT ? line.slice(0, idx).replace(/^- /, '') : line.slice(idx - FACT_CONTEXT, idx);
      const before = trimTrailing(lead.split(/[.;!?]\s+/).pop() ?? '').trim();
      const tail = line.slice(idx + m[0].length, idx + m[0].length + FACT_CONTEXT);
      const after = tail.replace(/^[\s/]*(?:mo|month|yr|year|user|seat)\b/i, '').replace(/^[\s:|—–\-·,)]+/, '').trim();
      let label = before || after.split(/[.;|]/)[0]?.trim() || 'price';
      label = label.split(' | ').pop()?.trim() || label;
      label = label.slice(0, 48);
      let key = heading && heading.toLowerCase() !== label.toLowerCase() ? `${heading} › ${label}` : label;
      const n = (seen.get(key) ?? 0) + 1;
      seen.set(key, n);
      if (n > 1) key = `${key} #${n}`;
      const value = Number((m[2] ?? '0').replace(/,/g, ''));
      if (Number.isFinite(value)) facts.push({ key, value, currency: CURRENCY[m[1] ?? '$'] ?? 'USD', raw: m[0] });
    }
  }
  return facts;
}

export function extract(html: string, opts: ExtractOptions = {}): Extraction {
  const doc = parse(html, { comment: false, blockTextElements: { script: false, noscript: false, style: false, pre: true } });
  for (const sel of opts.ignoreSelectors ?? []) {
    try {
      for (const el of doc.querySelectorAll(sel)) el.remove();
    } catch {
      // An invalid selector is rejected at the API boundary; ignore defensively here.
    }
  }
  let root: HTMLElement | null = null;
  let selectorMatched = true;
  if (opts.selector) {
    try {
      root = doc.querySelector(opts.selector);
    } catch {
      root = null;
    }
    if (!root) selectorMatched = false;
  }
  root ??= doc.querySelector('body') ?? doc;

  const lines = walk(root);
  const rawText = lines.join('\n');
  const masked: Record<string, number> = {};
  const userPatterns = (opts.ignorePatterns ?? []).map(compileIgnorePattern);
  const budget: ScanBudget = { left: IGNORE_PATTERN_BUDGET };
  let budgetSpent = false;

  const cleanLines: string[] = [];
  for (const line of lines) {
    let out = line;
    for (const f of NOISE_FILTERS) {
      out = out.replace(f.re, (m) => {
        if (f.accept && !f.accept(m)) return m;
        masked[f.name] = (masked[f.name] ?? 0) + 1;
        return f.token;
      });
    }
    for (const pattern of userPatterns) {
      if (budgetSpent) break;
      const r = stripWildcardMatches(out, pattern, budget);
      if (!r) {
        // Stop applying patterns for the rest of the page rather than stall the process.
        budgetSpent = true;
        masked['ignore_pattern_budget_exceeded'] = 1;
        break;
      }
      out = r.out;
      if (r.hits) masked['ignore_pattern'] = (masked['ignore_pattern'] ?? 0) + r.hits;
    }
    out = collapse(out);
    if (out && out !== '-' && out !== '#') cleanLines.push(out);
  }
  const text = cleanLines.join('\n');
  return {
    rawText,
    text,
    rawHash: sha256(rawText),
    hash: sha256(text),
    wordCount: text ? text.split(/\s+/).length : 0,
    facts: extractFacts(cleanLines),
    maskedTokens: masked,
    selectorMatched,
  };
}

/** Validate a CSS selector against the parser we actually use, at the API boundary. */
export function isValidSelector(sel: string): boolean {
  if (sel.length > 200) return false;
  try {
    parse('<div></div>').querySelectorAll(sel);
    return true;
  } catch {
    return false;
  }
}
