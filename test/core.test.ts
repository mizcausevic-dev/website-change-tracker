import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { diffText, toUnified } from '../src/core/diff.ts';
import { compileIgnorePattern, extract, stripWildcardMatches } from '../src/core/extract.ts';
import { isAllowed, parseRobots } from '../src/core/robots.ts';
import { compareFacts, editExcerpt, score } from '../src/core/significance.ts';
import { isPublicAddress } from '../src/core/ssrf.ts';
import { sign, verify } from '../src/core/webhooks.ts';
import { isId, newId, ulid } from '../src/ids.ts';
import { RateLimiter } from '../src/http/ratelimit.ts';

const html = (body: string): string => `<!doctype html><html><head><title>t</title><style>.x{}</style><script>var a=1</script></head><body>${body}</body></html>`;

describe('extract', () => {
  it('keeps headings, list items and table rows as structured lines', () => {
    const ex = extract(html('<main><h2>Plans</h2><ul><li>One</li><li>Two</li></ul><table><tr><td>Free</td><td>60</td></tr></table></main>'), { selector: 'main' });
    assert.equal(ex.text, '## Plans\n- One\n- Two\nFree | 60');
  });

  it('drops script/style content and hidden elements', () => {
    const ex = extract(html('<p>Visible</p><p hidden>Hidden</p><div aria-hidden="true">Also hidden</div>'));
    assert.equal(ex.text, 'Visible');
  });

  it('masks volatile tokens but never masks substantive numbers', () => {
    const a = extract(html('<p>Updated 5 minutes ago at 12:04:33 UTC. Session ref 9f8a7c6b5d4e3f2a1b0c9d8e7f6a5b4c</p><p>Data is deleted within 30 days.</p>'));
    const b = extract(html('<p>Updated 7 minutes ago at 12:09:01 UTC. Session ref 1f2e3d4c5b6a7980a1b2c3d4e5f60718</p><p>Data is deleted within 30 days.</p>'));
    assert.equal(a.hash, b.hash, 'only volatile tokens differ, so the filtered hashes match');
    assert.notEqual(a.rawHash, b.rawHash);
    const c = extract(html('<p>Updated 5 minutes ago at 12:04:33 UTC. Session ref 9f8a7c6b5d4e3f2a1b0c9d8e7f6a5b4c</p><p>Data is deleted within 90 days.</p>'));
    assert.notEqual(a.hash, c.hash, 'a retention-period change must not be masked');
  });

  it('removes ignore_selectors before extraction', () => {
    const ex = extract(html('<main><p>Keep</p><div class="ad">Buy now</div></main>'), { ignoreSelectors: ['.ad'] });
    assert.equal(ex.text, 'Keep');
  });

  it('reports a selector that matched nothing instead of silently using an empty page', () => {
    const ex = extract(html('<p>Body text</p>'), { selector: '#missing' });
    assert.equal(ex.selectorMatched, false);
    assert.equal(ex.text, 'Body text');
  });

  it('extracts price facts keyed by section and label', () => {
    const ex = extract(html('<h2>Plans</h2><p>Starter — $19/mo per seat</p><p>Team — $1,049.50/yr</p>'));
    assert.deepEqual(ex.facts.map((f) => [f.key, f.value]), [['Plans › Starter', 19], ['Plans › Team', 1049.5]]);
  });

  it('treats ignore patterns as literal text with * wildcards, not regex', () => {
    const strip = (line: string, p: string) => stripWildcardMatches(line, compileIgnorePattern(p), { left: 1e9 })!.out;
    assert.equal(strip('Promo (a+)+$ for you ends today', 'Promo (a+)+$ * ends'), ' today', 'regex metacharacters are literal');
    assert.equal(strip('SALE ends Friday | sale ends Monday', 'sale ends *day'), ' | ', 'case-insensitive, shortest match, every occurrence');
    assert.equal(strip('a' + 'x'.repeat(400) + 'b', 'a*b'), '', 'a wildcard spans up to 400 characters');
    assert.equal(strip('a' + 'x'.repeat(401) + 'b', 'a*b'), 'a' + 'x'.repeat(401) + 'b', 'and no further');
    assert.equal(strip('keep this', '*'), 'keep this', 'a bare wildcard removes nothing');
    assert.equal(strip('Posted 3 hours ago by admin', '* ago'), ' by admin', 'a leading wildcard reaches back up to 400 characters');
    assert.equal(strip('İstanbul office: Sale ends', 'sale'), 'İstanbul office:  ends', 'a Turkish İ does not disable matching on the line');
  });
});

describe('ignore pattern and noise filter cost', () => {
  // Regression: wildcards used to compile to a backtracking regex; `a*a*a*b` against 2,000 characters
  // ran for over 20 seconds. Page text is attacker-controlled too, so the built-in filters are checked as well.
  const page = (line: string, n: number) => `<body>${Array.from({ length: n }, () => `<p>${line}</p>`).join('')}</body>`;
  const timed = (fn: () => void) => {
    const t = performance.now();
    fn();
    return performance.now() - t;
  };

  it('bounds stacked wildcards that defeated the old regex', () => {
    const ms = timed(() => extract(page('x'.repeat(2000), 10), { ignorePatterns: ['x*x*x*q'] }));
    assert.ok(ms < 500, `took ${Math.round(ms)} ms`);
  });

  it('caps total work per page and flags it instead of stalling', () => {
    let ex!: ReturnType<typeof extract>;
    const ms = timed(() => {
      ex = extract(page('x'.repeat(2000), 1000), { ignorePatterns: Array.from({ length: 20 }, () => `${'x*'.repeat(99)}q`) });
    });
    assert.ok(ms < 2000, `took ${Math.round(ms)} ms`);
    assert.equal(ex.maskedTokens['ignore_pattern_budget_exceeded'], 1);
  });

  it('keeps built-in filters linear on hostile page text', () => {
    for (const line of ['a-'.repeat(1000), '1,'.repeat(1000)]) {
      const ms = timed(() => extract(page(line, 200)));
      assert.ok(ms < 150, `${line.slice(0, 4)}…: ${Math.round(ms)} ms`);
    }
  });

  it('does not exhaust the budget on a large benign page with many patterns', () => {
    const prose = 'The quick brown fox jumps over the lazy dog while the editors review pricing tables. '.repeat(23);
    const ex = extract(page(prose, 1000), { ignorePatterns: Array.from({ length: 20 }, (_, i) => `nomatch${i}*never`) });
    assert.equal(ex.maskedTokens['ignore_pattern_budget_exceeded'], undefined);
  });

  it('keeps price extraction linear and capped on hostile text', () => {
    let ex!: ReturnType<typeof extract>;
    const ms = timed(() => {
      ex = extract(page(`${'- '.repeat(700)}x${' $1'.repeat(190)}`, 200));
    });
    assert.ok(ms < 1500, `took ${Math.round(ms)} ms`);
    assert.ok(extract(page('$1 '.repeat(666), 50)).facts.length <= 100, 'facts are capped per page');
    assert.ok(ex.facts.length <= 100);
  });

  it('still masks real volatile tokens', () => {
    const ex = extract(page('Session ref Ab3dE6gH9jK2mN5pQ8rS1tU4 · 1,284 views · ends in 3 hours', 1));
    assert.equal(ex.text, 'Session ref {token} · {count} · {countdown}');
  });
});

describe('diff', () => {
  it('pairs edited lines and produces word-level segments', () => {
    const d = diffText('## Plans\nStarter — $19/mo\nTeam — $49/mo', '## Plans\nStarter — $24/mo\nTeam — $49/mo');
    assert.equal(d.edits.length, 1);
    assert.equal(d.wordsAdded, 1);
    assert.equal(d.wordsRemoved, 1);
    const add = d.hunks[0]!.lines.find((l) => l.op === 'add');
    assert.ok(add && 'segments' in add && add.segments?.some((s) => s.op === 'add' && s.text === '24'));
    assert.deepEqual(d.headingsTouched, ['Plans']);
  });

  it('separates pure insertions from edits', () => {
    const d = diffText('a\nb', 'a\nb\nc');
    assert.deepEqual(d.pureAdded, ['c']);
    assert.equal(d.edits.length, 0);
  });

  it('renders a valid unified diff', () => {
    const d = diffText('one\ntwo\nthree', 'one\n2\nthree');
    const u = toUnified(d.hunks, 'a', 'b');
    assert.match(u, /^--- a\n\+\+\+ b\n@@ -1,3 \+1,3 @@\n one\n-two\n\+2\n three\n$/);
  });
});

describe('significance', () => {
  it('scores price changes above the default threshold and summarizes them', () => {
    const before = extract(html('<h2>Plans</h2><p>Team — $49/mo</p>'));
    const after = extract(html('<h2>Plans</h2><p>Team — $59/mo</p>'));
    const fc = compareFacts(before.facts, after.facts);
    const s = score(diffText(before.text, after.text), before.wordCount, fc);
    assert.equal(s.category, 'pricing');
    assert.ok(s.significance >= 60, `got ${s.significance}`);
    assert.equal(s.summary, 'Plans: Team $49 → $59 (+20.4%)');
  });

  it('halves tiny non-financial edits such as counters', () => {
    const s = score(diffText('Rated 4.7 from 1,464 reviews', 'Rated 4.7 from 1,465 reviews'), 30, []);
    assert.ok(s.significance < 15, `got ${s.significance}`);
    assert.ok(s.signals.some((x) => x.includes('halved')));
  });

  it('does not halve small legal edits', () => {
    const s = score(diffText('## 3. Personal data\nWe retain account data for 30 days.', '## 3. Personal data\nWe retain account data for 90 days.'), 120, []);
    assert.equal(s.category, 'legal');
    assert.ok(s.significance >= 40, `got ${s.significance}`);
  });

  it('centres edit excerpts on the difference', () => {
    const [a, b] = editExcerpt('We build scheduling infrastructure for hospitals. 6 open roles.', 'We build scheduling infrastructure for hospitals. 7 open roles.');
    assert.ok(a.includes('6 open roles') && b.includes('7 open roles'));
  });
});

describe('ssrf guard', () => {
  const blocked = ['127.0.0.1', '10.1.2.3', '172.16.0.1', '192.168.1.1', '169.254.169.254', '100.64.0.1', '0.0.0.0', '::1', 'fe80::1', 'fd00::1', '::ffff:127.0.0.1', '::ffff:7f00:1', '::ffff:a9fe:a9fe', '64:ff9b::7f00:1', 'not-an-ip'];
  const allowed = ['93.184.215.14', '8.8.8.8', '2606:4700:4700::1111', '::ffff:8.8.8.8'];
  for (const ip of blocked) it(`blocks ${ip}`, () => assert.equal(isPublicAddress(ip), false));
  for (const ip of allowed) it(`allows ${ip}`, () => assert.equal(isPublicAddress(ip), true));
});

describe('robots.txt', () => {
  const groups = parseRobots('User-agent: *\nDisallow: /private\nAllow: /private/ok\n\nUser-agent: DriftlineBot\nDisallow: /bot-only\n');
  it('prefers the specific user-agent group', () => {
    assert.equal(isAllowed(groups, 'DriftlineBot', '/bot-only/x'), false);
    assert.equal(isAllowed(groups, 'DriftlineBot', '/private'), true, 'the * group does not apply once a specific group matches');
  });
  it('uses longest match with Allow winning', () => {
    assert.equal(isAllowed(groups, 'OtherBot', '/private/x'), false);
    assert.equal(isAllowed(groups, 'OtherBot', '/private/ok/page'), true);
  });
});

describe('webhook signatures', () => {
  // Derived at runtime so no credential-shaped literal lives in the repository.
  const secret = `whsec_${Buffer.from('driftline-test-signing-key').toString('base64')}`;
  const body = '{"type":"change.detected"}';
  const ts = 1_700_000_000;
  const headers = { 'webhook-id': 'msg_1', 'webhook-timestamp': String(ts), 'webhook-signature': sign(secret, 'msg_1', ts, body) };
  it('verifies a valid signature', () => assert.equal(verify(secret, headers, body, ts + 10), true));
  it('rejects a tampered body', () => assert.equal(verify(secret, headers, body.replace('change', 'chang3'), ts), false));
  it('rejects a stale timestamp (replay)', () => assert.equal(verify(secret, headers, body, ts + 301), false));
  it('rejects the wrong secret', () => assert.equal(verify('whsec_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA', headers, body, ts), false));
});

describe('ids', () => {
  it('are prefixed, valid and time-sortable even within one millisecond', () => {
    const ids = Array.from({ length: 50 }, () => newId('chg', 1_700_000_000_000));
    assert.ok(ids.every((i) => isId(i, 'chg')));
    assert.deepEqual([...ids].sort(), ids);
    assert.ok(ulid(1_700_000_000_001) > ulid(1_700_000_000_000));
  });
});

describe('rate limiter', () => {
  it('allows the limit, then 429s with a retry hint, then refills', () => {
    const rl = new RateLimiter();
    for (let i = 0; i < 3; i++) assert.equal(rl.take('k', 3, 0).allowed, true);
    const d = rl.take('k', 3, 0);
    assert.equal(d.allowed, false);
    assert.equal(d.retryAfterSec, 20);
    assert.equal(rl.take('k', 3, 20_000).allowed, true);
  });
});
