import type { DiffResult } from './diff.ts';
import type { Fact } from './extract.ts';

export const CATEGORIES = ['pricing', 'legal', 'status', 'product', 'hiring', 'content'] as const;
export type Category = (typeof CATEGORIES)[number];

export interface FactChange {
  key: string;
  from: number | null;
  to: number | null;
  currency: string;
  pct: number | null;
}

export interface Scored {
  significance: number;
  category: Category;
  summary: string;
  signals: string[];
  factChanges: FactChange[];
}

const KEYWORDS: Record<Exclude<Category, 'content'>, RegExp> = {
  legal: /\b(terms|privacy|liabilit\w*|arbitration|governing law|indemnif\w*|warrant\w*|personal data|retain|retention|consent|jurisdiction|shall|class action|opt[- ]out)\b/gi,
  pricing: /[$€£]|\b(price|pricing|per (?:month|seat|user)|\/mo|plan|tier|billing|discount|sale|free trial|in stock|sold out|low stock|backorder)\b/gi,
  status: /\b(incident|outage|degraded|operational|maintenance|investigating|identified|monitoring|resolved|partial)\b/gi,
  product: /\b(release[sd]?|launch\w*|deprecat\w*|version|api|sdk|endpoint|rate limits?|requests? per|feature|added|fixed|improved|breaking)\b/gi,
  hiring: /\b(engineer|manager|designer|analyst|role|position|apply|hiring|full-time|part-time|opening)\b/gi,
};
const PRIORITY: Category[] = ['legal', 'pricing', 'status', 'product', 'hiring', 'content'];
const CATEGORY_BONUS: Record<Category, number> = { legal: 25, pricing: 15, status: 12, product: 10, hiring: 8, content: 0 };

export function compareFacts(before: Fact[], after: Fact[]): FactChange[] {
  const a = new Map(before.map((f) => [f.key, f]));
  const b = new Map(after.map((f) => [f.key, f]));
  const out: FactChange[] = [];
  for (const [key, f] of b) {
    const prev = a.get(key);
    if (!prev) out.push({ key, from: null, to: f.value, currency: f.currency, pct: null });
    else if (prev.value !== f.value) {
      const pct = prev.value === 0 ? null : Math.round(((f.value - prev.value) / prev.value) * 1000) / 10;
      out.push({ key, from: prev.value, to: f.value, currency: f.currency, pct });
    }
  }
  for (const [key, f] of a) if (!b.has(key)) out.push({ key, from: f.value, to: null, currency: f.currency, pct: null });
  return out;
}

const money = (n: number | null, cur: string): string =>
  n === null ? '—' : `${cur === 'EUR' ? '€' : cur === 'GBP' ? '£' : '$'}${Number.isInteger(n) ? n : n.toFixed(2)}`;

const excerpt = (s: string, n = 72): string => {
  const t = s.replace(/^#{1,6} |^- /, '');
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
};

export function describeFact(f: FactChange): string {
  const label = f.key.split(' › ').pop() ?? f.key;
  if (f.from === null) return `${label} added at ${money(f.to, f.currency)}`;
  if (f.to === null) return `${label} (${money(f.from, f.currency)}) removed`;
  const pct = f.pct === null ? '' : ` (${f.pct > 0 ? '+' : ''}${f.pct}%)`;
  return `${label} ${money(f.from, f.currency)} → ${money(f.to, f.currency)}${pct}`;
}

/** Excerpt of an in-place edit centred on where the two lines first differ, so the summary shows the actual change. */
export function editExcerpt(before: string, after: string, width = 44): [string, string] {
  const a = before.replace(/^#{1,6} |^- /, '');
  const b = after.replace(/^#{1,6} |^- /, '');
  let p = 0;
  while (p < a.length && p < b.length && a[p] === b[p]) p++;
  let s = 0;
  while (s < a.length - p && s < b.length - p && a[a.length - 1 - s] === b[b.length - 1 - s]) s++;
  const cut = (t: string): string => {
    // Back off to a word boundary so the excerpt never starts mid-word.
    const start = p > 16 ? t.lastIndexOf(' ', p - 16) + 1 : 0;
    const end = Math.min(t.length, Math.max(t.length - s + 16, start + width));
    return `${start > 0 ? '…' : ''}${t.slice(start, end)}${end < t.length ? '…' : ''}`;
  };
  return [cut(a), cut(b)];
}

export function score(diff: DiffResult, oldWords: number, factChanges: FactChange[]): Scored {
  // Section headings count toward the category: a table row edit under "Rate limits" is a product change.
  const changed = [...diff.linesAdded, ...diff.linesRemoved, ...diff.headingsTouched].join('\n');
  const hits: Record<Category, number> = { legal: 0, pricing: 0, status: 0, product: 0, hiring: 0, content: 0 };
  for (const [cat, re] of Object.entries(KEYWORDS) as Array<[Exclude<Category, 'content'>, RegExp]>) {
    hits[cat] = changed.match(re)?.length ?? 0;
  }
  if (factChanges.length) hits.pricing += 5;
  let category: Category = 'content';
  let best = 0;
  for (const cat of PRIORITY) {
    if (hits[cat] > best) {
      best = hits[cat];
      category = cat;
    }
  }

  const signals: string[] = [];
  const delta = diff.wordsAdded + diff.wordsRemoved;
  const ratio = delta / Math.max(oldWords, 20);
  let s = Math.min(35, Math.round(Math.sqrt(ratio) * 70));
  signals.push(`${(ratio * 100).toFixed(1)}% of words changed (+${diff.wordsAdded} / −${diff.wordsRemoved})`);

  if (factChanges.length) {
    const maxPct = Math.max(0, ...factChanges.map((f) => Math.abs(f.pct ?? 25)));
    s += 35 + Math.min(15, Math.round(maxPct / 2));
    signals.push(`${factChanges.length} price point${factChanges.length > 1 ? 's' : ''} changed`);
  }
  if (category !== 'content') {
    s += CATEGORY_BONUS[category];
    signals.push(`${category} language in changed lines (${hits[category]} hits)`);
  }
  const headingChanges = [...diff.linesAdded, ...diff.linesRemoved].filter((l) => /^#{1,6} /.test(l)).length;
  if (headingChanges) {
    s += 8;
    signals.push(`${headingChanges} section heading${headingChanges > 1 ? 's' : ''} added or removed`);
  }
  // A changed number inside an edited line (limits, retention periods, percentages) is a substantive edit.
  const numericEdit = diff.edits.some(([a, b]) => (a.match(/\d[\d,.]*/g) ?? []).join() !== (b.match(/\d[\d,.]*/g) ?? []).join());
  if (numericEdit && category !== 'content' && !factChanges.length) {
    s += 10;
    signals.push('a number changed in an edited line');
  }
  // Tiny edits (a counter ticking, a typo) are halved unless money, a percentage, or legal text moved.
  const moneyOrPct = /[$€£%]/.test([...diff.linesAdded, ...diff.linesRemoved].join(' '));
  if (delta <= 2 && !factChanges.length && !moneyOrPct && category !== 'legal') {
    s = Math.round(s * 0.5);
    signals.push('tiny edit (≤2 words), halved');
  }
  const significance = Math.max(1, Math.min(100, s));

  let summary: string;
  const newHeading = diff.pureAdded.find((l) => /^#{1,6} /.test(l)) ?? diff.edits.find(([, b]) => /^#{1,6} /.test(b))?.[1];
  if (factChanges.length) {
    summary = factChanges.slice(0, 2).map(describeFact).join('; ');
    if (factChanges.length > 2) summary += `; +${factChanges.length - 2} more`;
  } else if (newHeading && category === 'status') {
    summary = excerpt(newHeading, 80);
  } else if (newHeading) {
    summary = `New section “${excerpt(newHeading, 60)}”`;
  } else if (diff.pureAdded.length || diff.pureRemoved.length) {
    const parts: string[] = [];
    if (diff.pureAdded[0]) parts.push(`Added “${excerpt(diff.pureAdded[0], 56)}”${diff.pureAdded.length > 1 ? ` (+${diff.pureAdded.length - 1} more)` : ''}`);
    if (diff.pureRemoved[0]) parts.push(`removed “${excerpt(diff.pureRemoved[0], 56)}”${diff.pureRemoved.length > 1 ? ` (+${diff.pureRemoved.length - 1} more)` : ''}`);
    summary = parts.join('; ');
    summary = summary.charAt(0).toUpperCase() + summary.slice(1);
  } else if (diff.edits[0]) {
    const [a, b] = editExcerpt(diff.edits[0][0], diff.edits[0][1]);
    summary = `Changed “${a}” → “${b}”`;
  } else summary = 'Whitespace-only change';
  const section = diff.headingsTouched.find((h) => h !== '(top of page)');
  if (section && !summary.startsWith('New section') && category !== 'status') summary = `${section}: ${summary}`;

  return { significance, category, summary, signals, factChanges };
}
