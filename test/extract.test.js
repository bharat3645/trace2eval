import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { flattenSpans } from '../lib/otel.js';
import { spansToCases, extractMessages } from '../lib/extract.js';

const fixture = JSON.parse(readFileSync(new URL('./fixtures/sample-traces.json', import.meta.url), 'utf8'));
const spans = flattenSpans(fixture);

test('spansToCases stats over the fixture', () => {
  const { cases, stats } = spansToCases(spans);
  assert.equal(stats.spans_total, 10);
  assert.equal(stats.genai_spans, 9);
  assert.equal(stats.tool_spans, 1);
  assert.equal(stats.skipped_error, 1);
  assert.equal(stats.skipped_no_output, 1);
  assert.equal(stats.skipped_no_input, 0);
  assert.equal(stats.cases, 6); // pre-dedupe
  assert.equal(cases.length, 6);
});

test('gen_ai.prompt / gen_ai.completion attribute-JSON form', () => {
  const { cases } = spansToCases(spans);
  const c = cases.find((x) => x.meta.span_id === 'a1a1a1a1a1a1a1a1');
  assert.equal(c.input.messages.length, 2);
  assert.equal(c.input.messages[0].role, 'system');
  assert.equal(c.input.messages[1].content, 'How do I reset my password?');
  assert.match(c.expected.content, /Forgot password/);
  assert.equal(c.meta.model, 'gpt-4o-mini-2024-07-18'); // response.model preferred
  assert.deepEqual(c.meta.usage, { input_tokens: 42, output_tokens: 31 });
  assert.equal(c.meta.operation, 'chat');
});

test('gen_ai.input/output.messages form with tool_calls', () => {
  const { cases } = spansToCases(spans);
  const c = cases.find((x) => x.meta.span_id === 'd4d4d4d4d4d4d4d4');
  assert.equal(c.input.messages[0].content, "What's the weather in Paris right now?");
  assert.equal(c.expected.tool_calls.length, 1);
  assert.equal(c.expected.tool_calls[0].name, 'get_weather');
  assert.deepEqual(c.expected.tool_calls[0].arguments, { city: 'Paris' });
});

test('execute_tool child span attaches to parent case', () => {
  const { cases } = spansToCases(spans);
  const c = cases.find((x) => x.meta.span_id === 'd4d4d4d4d4d4d4d4');
  assert.equal(c.tools.length, 1);
  assert.equal(c.tools[0].name, 'get_weather');
  assert.equal(c.tools[0].call_id, 'call_1');
  assert.deepEqual(c.tools[0].arguments, { city: 'Paris' });
  assert.deepEqual(c.tools[0].result, { temp_c: 21, condition: 'clear' });
});

test('legacy indexed gen_ai.prompt.N.* form', () => {
  const { cases } = spansToCases(spans);
  const c = cases.find((x) => x.meta.span_id === '9a9a9a9a9a9a9a9a');
  assert.equal(c.input.messages[0].role, 'user');
  assert.match(c.input.messages[0].content, /Q2 incident review/);
  assert.match(c.expected.content, /config drift/);
  assert.equal(c.meta.system, 'anthropic');
});

test('event-based gen_ai.content.prompt/completion form', () => {
  const { cases } = spansToCases(spans);
  const c = cases.find((x) => x.meta.span_id === '8b8b8b8b8b8b8b8b');
  assert.equal(c.input.messages[0].content, 'Translate to French: Good morning');
  assert.equal(c.expected.content, 'Bonjour');
});

test('message-event form (gen_ai.user.message / gen_ai.choice)', () => {
  const span = {
    traceId: 't1',
    spanId: 's1',
    parentSpanId: '',
    name: 'chat',
    startMs: 0,
    endMs: 1,
    durationMs: 1,
    status: 'ok',
    resource: {},
    attributes: { 'gen_ai.system': 'openai', 'gen_ai.operation.name': 'chat' },
    events: [
      { name: 'gen_ai.system.message', timeMs: 0, attributes: { content: 'Be terse.' } },
      { name: 'gen_ai.user.message', timeMs: 0, attributes: { content: 'Ping?' } },
      { name: 'gen_ai.choice', timeMs: 1, attributes: { body: '{"message":{"role":"assistant","content":"Pong."},"finish_reason":"stop"}' } },
    ],
  };
  const { input, output } = extractMessages(span);
  assert.equal(input.length, 2);
  assert.equal(input[0].role, 'system');
  assert.equal(input[1].content, 'Ping?');
  assert.equal(output.length, 1);
  assert.equal(output[0].content, 'Pong.');
});

test('parts-array content is joined', () => {
  const span = {
    traceId: 't2',
    spanId: 's2',
    parentSpanId: '',
    name: 'chat',
    startMs: 0,
    endMs: 1,
    durationMs: 1,
    status: 'ok',
    resource: {},
    attributes: {
      'gen_ai.input.messages': JSON.stringify([
        { role: 'user', parts: [{ type: 'text', content: 'line one' }, { type: 'text', content: 'line two' }] },
      ]),
      'gen_ai.output.messages': JSON.stringify([{ role: 'assistant', content: 'ok' }]),
    },
    events: [],
  };
  const { input } = extractMessages(span);
  assert.equal(input[0].content, 'line one\nline two');
});

test('error spans are skipped, not silently dropped', () => {
  const { cases, stats } = spansToCases(spans);
  assert.equal(stats.skipped_error, 1);
  assert.ok(!cases.some((c) => c.meta.span_id === 'e6e6e6e6e6e6e6e6'));
});
