import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { convert } from '../lib/convert.js';
import { coverageSummary } from '../lib/coverage.js';

const fixture = JSON.parse(readFileSync(new URL('./fixtures/sample-traces.json', import.meta.url), 'utf8'));

test('convert end-to-end totals over the fixture', () => {
  const { cases, coverage } = convert([fixture]);
  assert.equal(cases.length, 5);
  const t = coverage.totals;
  assert.equal(t.spans_seen, 10);
  assert.equal(t.genai_spans, 9);
  assert.equal(t.tool_spans, 1);
  assert.equal(t.cases, 5);
  assert.equal(t.duplicates_removed, 1);
  assert.equal(t.skipped_error, 1);
  assert.equal(t.skipped_no_output, 1);
  assert.equal(t.cases_scrubbed, 1);
  assert.deepEqual(t.scrub_counts, { EMAIL: 2, PHONE: 1, CREDIT_CARD: 1, IP: 1, API_KEY: 1 });
});

test('scrubbed dataset contains placeholders, not raw PII', () => {
  const { cases } = convert([fixture]);
  const text = JSON.stringify(cases);
  assert.ok(!text.includes('alice@example.com'));
  assert.ok(!text.includes('4111 1111 1111 1111'));
  assert.ok(!text.includes('sk-abcdef1234567890ABCDEF12'));
  assert.ok(text.includes('<EMAIL_1>'));
  assert.ok(text.includes('<CREDIT_CARD_1>'));
});

test('--no-scrub equivalent leaves content untouched', () => {
  const { cases } = convert([fixture], { scrub: false });
  const text = JSON.stringify(cases);
  assert.ok(text.includes('alice@example.com'));
});

test('coverage breakdowns', () => {
  const { coverage } = convert([fixture]);
  assert.deepEqual(coverage.by_model, {
    'gpt-4o-mini-2024-07-18': 1,
    'gpt-4o': 3,
    'claude-sonnet-4-5': 1,
  });
  assert.deepEqual(coverage.by_system, { openai: 4, anthropic: 1 });
  assert.deepEqual(coverage.by_operation, { chat: 5 });
  assert.equal(coverage.tools.cases_with_tools, 1);
  assert.equal(coverage.tools.by_tool.get_weather, 2); // execute_tool span + expected tool_call
  assert.deepEqual(coverage.input_token_buckets, { '0-100': 2, '101-500': 1, '501-2000': 2 });
  assert.equal(coverage.multi_turn.single_turn, 5);
  assert.equal(coverage.multi_turn.multi_turn, 0);
  assert.ok(coverage.time_range.first_ms < coverage.time_range.last_ms);
});

test('deterministic ids across runs', () => {
  const a = convert([fixture]).cases.map((c) => c.id);
  const b = convert([fixture]).cases.map((c) => c.id);
  assert.deepEqual(a, b);
});

test('keepDuplicates yields 6 cases from the fixture', () => {
  const { cases, coverage } = convert([fixture], { keepDuplicates: true });
  assert.equal(cases.length, 6);
  assert.equal(coverage.totals.duplicates_removed, 0);
});

test('coverageSummary mentions the headline numbers', () => {
  const { coverage } = convert([fixture]);
  const s = coverageSummary(coverage);
  assert.match(s, /cases: 5/);
  assert.match(s, /1 duplicate removed/);
  assert.match(s, /scrubbed: 6 PII\/secret values in 1 case/);
  assert.match(s, /gpt-4o:3/);
  assert.match(s, /get_weather:2/);
});
