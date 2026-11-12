import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { diffText, toUnified } from '../src/core/diff.ts';
import { compileIgnorePattern, extract } from '../src/core/extract.ts';
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
    const re = compileIgnorePattern('Promo (a+)+$ * ends');
    assert.equal(re.test('Promo (a+)+$ for you ends'), true);
    // A catastrophic-backtracking regex body is inert here because it is escaped.
    const t = performance.now();
    compileIgnorePattern('(a+)+$').test('a'.repeat(5000) + '!');
    assert.ok(performance.now() - t < 50);
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
