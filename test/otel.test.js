import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { anyValueToJs, attrsToObject, flattenSpans, isGenAiSpan, isToolSpan } from '../lib/otel.js';

const fixture = JSON.parse(readFileSync(new URL('./fixtures/sample-traces.json', import.meta.url), 'utf8'));

test('anyValueToJs decodes OTLP value envelopes', () => {
  assert.equal(anyValueToJs({ stringValue: 'x' }), 'x');
  assert.equal(anyValueToJs({ intValue: '42' }), 42);
  assert.equal(anyValueToJs({ intValue: 7 }), 7);
  assert.equal(anyValueToJs({ doubleValue: 1.5 }), 1.5);
  assert.equal(anyValueToJs({ boolValue: true }), true);
  assert.deepEqual(anyValueToJs({ arrayValue: { values: [{ stringValue: 'a' }, { intValue: '2' }] } }), ['a', 2]);
  assert.deepEqual(
    anyValueToJs({ kvlistValue: { values: [{ key: 'k', value: { stringValue: 'v' } }] } }),
    { k: 'v' }
  );
  assert.equal(anyValueToJs('plain'), 'plain');
  assert.equal(anyValueToJs(3), 3);
  assert.equal(anyValueToJs(null), null);
});

test('anyValueToJs keeps out-of-range intValue as string', () => {
  assert.equal(anyValueToJs({ intValue: '9007199254740993' }), '9007199254740993');
});

test('attrsToObject handles OTLP arrays and plain objects', () => {
  assert.deepEqual(attrsToObject([{ key: 'a', value: { stringValue: '1' } }]), { a: '1' });
  assert.deepEqual(attrsToObject({ a: { intValue: '2' }, b: 'raw' }), { a: 2, b: 'raw' });
  assert.deepEqual(attrsToObject(undefined), {});
});

test('flattenSpans flattens the OTLP fixture', () => {
  const spans = flattenSpans(fixture);
  assert.equal(spans.length, 10);
  assert.equal(spans[0].resource['service.name'], 'support-bot');
  assert.equal(spans[0].attributes['gen_ai.system'], 'openai');
  assert.equal(spans[0].attributes['gen_ai.usage.input_tokens'], 42);
  assert.equal(spans[0].status, 'ok');
  assert.ok(Math.abs(spans[0].durationMs - 850) < 1e-6);
});

test('flattenSpans normalizes error status', () => {
  const spans = flattenSpans(fixture);
  const err = spans.find((s) => s.traceId.startsWith('eeee'));
  assert.equal(err.status, 'error');
});

test('flattenSpans decodes span events', () => {
  const spans = flattenSpans(fixture);
  const evented = spans.find((s) => s.spanId === '8b8b8b8b8b8b8b8b');
  assert.equal(evented.events.length, 2);
  assert.equal(evented.events[0].name, 'gen_ai.content.prompt');
  assert.match(evented.events[0].attributes['gen_ai.prompt'], /Translate to French/);
});

test('flattenSpans accepts pre-flattened and bare-array shapes', () => {
  const bare = [{ traceId: 't', spanId: 's', name: 'x', attributes: { 'gen_ai.system': 'openai' } }];
  assert.equal(flattenSpans(bare).length, 1);
  assert.equal(flattenSpans({ spans: bare }).length, 1);
  assert.equal(flattenSpans(bare)[0].attributes['gen_ai.system'], 'openai');
});

test('flattenSpans rejects unrecognized documents', () => {
  assert.throws(() => flattenSpans({ hello: 'world' }), TypeError);
  assert.throws(() => flattenSpans('nope'), TypeError);
});

test('isGenAiSpan / isToolSpan classify spans', () => {
  const spans = flattenSpans(fixture);
  const http = spans.find((s) => s.name === 'GET /api/health');
  assert.equal(isGenAiSpan(http), false);
  const tool = spans.find((s) => s.spanId === 'd5d5d5d5d5d5d5d5');
  assert.equal(isGenAiSpan(tool), true);
  assert.equal(isToolSpan(tool), true);
  const chat = spans.find((s) => s.spanId === 'a1a1a1a1a1a1a1a1');
  assert.equal(isToolSpan(chat), false);
});
