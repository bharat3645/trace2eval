import { test } from 'node:test';
import assert from 'node:assert/strict';
import { scrubText, scrubCase, createScrubState } from '../lib/scrub.js';

function scrub(text) {
  const state = createScrubState();
  return { out: scrubText(text, state), counts: state.counts };
}

test('emails are scrubbed with stable placeholders', () => {
  const { out, counts } = scrub('Contact alice@example.com or bob@test.org, then alice@example.com again.');
  assert.equal(out, 'Contact <EMAIL_1> or <EMAIL_2>, then <EMAIL_1> again.');
  assert.equal(counts.EMAIL, 3);
});

test('phone numbers in common formats', () => {
  for (const p of ['+1 (415) 555-0134', '415-555-0134', '+44 20 7946 0958', '4155550134']) {
    const { out, counts } = scrub(`call ${p} now`);
    assert.ok(!out.includes(p), `${p} should be scrubbed, got: ${out}`);
    assert.equal(counts.PHONE, 1, p);
  }
});

test('short digit runs, years, versions, decimals are NOT phones', () => {
  for (const s of ['order 12345 shipped', 'year 2026', 'v1.2.3 released', 'pi is 3.14159265358979', 'HTTP 404']) {
    const { out } = scrub(s);
    assert.equal(out, s);
  }
});

test('SSNs are scrubbed', () => {
  const { out, counts } = scrub('SSN: 123-45-6789.');
  assert.equal(out, 'SSN: <SSN_1>.');
  assert.equal(counts.SSN, 1);
});

test('credit cards must pass Luhn', () => {
  const valid = scrub('card 4111 1111 1111 1111 charged');
  assert.equal(valid.out, 'card <CREDIT_CARD_1> charged');
  assert.equal(valid.counts.CREDIT_CARD, 1);
  // fails Luhn → left alone by the CC detector (and 16 digits > phone max 15)
  const invalid = scrub('ref 4111 1111 1111 1112');
  assert.ok(invalid.out.includes('4111 1111 1111 1112'));
  assert.equal(invalid.counts.CREDIT_CARD, undefined);
});

test('IPv4 addresses validated per octet', () => {
  const { out, counts } = scrub('host 203.0.113.9 responded');
  assert.equal(out, 'host <IP_1> responded');
  assert.equal(counts.IP, 1);
  const bogus = scrub('checksum 999.999.999.999 here');
  assert.equal(bogus.counts.IP, undefined);
});

test('API keys and tokens', () => {
  const cases = [
    'sk-abcdef1234567890ABCDEF12',
    'ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789',
    'AKIAIOSFODNN7EXAMPLE',
    'xoxb-123456789012-abcdefghij',
  ];
  for (const k of cases) {
    const { out, counts } = scrub(`token ${k} leaked`);
    assert.ok(!out.includes(k), `${k} should be scrubbed`);
    assert.equal(counts.API_KEY, 1, k);
  }
  const bearer = scrub('Authorization: Bearer abc123def456ghi789jkl');
  assert.equal(bearer.counts.API_KEY, 1);
});

test('JWTs are scrubbed as JWT, not API_KEY', () => {
  const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U';
  const { out, counts } = scrub(`token ${jwt}`);
  assert.equal(counts.JWT, 1);
  assert.ok(out.includes('<JWT_1>'));
});

test('scrubCase covers messages, expected, tool args and results', () => {
  const c = {
    input: {
      messages: [
        { role: 'user', content: 'I am carol@corp.io, card 4111 1111 1111 1111' },
        {
          role: 'assistant',
          content: '',
          tool_calls: [{ id: 't1', name: 'lookup', arguments: { email: 'carol@corp.io' } }],
        },
      ],
    },
    expected: { role: 'assistant', content: 'Emailed carol@corp.io.' },
    tools: [{ name: 'lookup', call_id: 't1', arguments: { email: 'carol@corp.io' }, result: 'found carol@corp.io', status: 'ok' }],
    meta: {},
  };
  const counts = scrubCase(c);
  assert.equal(counts.EMAIL, 5);
  assert.equal(counts.CREDIT_CARD, 1);
  assert.equal(c.input.messages[0].content, 'I am <EMAIL_1>, card <CREDIT_CARD_1>');
  assert.equal(c.input.messages[1].tool_calls[0].arguments.email, '<EMAIL_1>');
  assert.equal(c.expected.content, 'Emailed <EMAIL_1>.');
  assert.equal(c.tools[0].arguments.email, '<EMAIL_1>');
  assert.equal(c.tools[0].result, 'found <EMAIL_1>');
});

test('scrubCase returns null when nothing found', () => {
  const c = {
    input: { messages: [{ role: 'user', content: 'hello world' }] },
    expected: { role: 'assistant', content: 'hi' },
    tools: [],
    meta: {},
  };
  assert.equal(scrubCase(c), null);
});

test('empty and non-string inputs are safe', () => {
  const state = createScrubState();
  assert.equal(scrubText('', state), '');
  assert.equal(scrubText(null, state), null);
  assert.equal(scrubText(undefined, state), undefined);
});
