// bench.js — synthetic throughput benchmark for the full convert pipeline.
// Generates N OTLP chat spans (20% duplicates, 10% with PII, 10% tool flows)
// and times parse-free conversion (docs already parsed) plus JSONL encode.
// Run: npm run bench [-- N]

import { convert, toJsonl } from '../lib/convert.js';

const N = Number(process.argv[2]) || 10000;

function span(i) {
  const dup = i % 5 === 0; // 20% duplicates of a shared prompt
  const pii = i % 10 === 3;
  const q = dup
    ? 'What is your refund policy?'
    : `Customer question #${i}: how do I configure widget ${i}?${pii ? ' My email is user' + i + '@example.com and my phone is +1 (415) 555-01' + String(i % 100).padStart(2, '0') + '.' : ''}`;
  const s = {
    traceId: String(i).padStart(32, '0'),
    spanId: String(i).padStart(16, '0'),
    name: 'chat gpt-4o-mini',
    startTimeUnixNano: String(1752600000000000000 + i * 1e6),
    endTimeUnixNano: String(1752600000000000000 + i * 1e6 + 5e8),
    status: { code: 1 },
    attributes: [
      { key: 'gen_ai.system', value: { stringValue: 'openai' } },
      { key: 'gen_ai.operation.name', value: { stringValue: 'chat' } },
      { key: 'gen_ai.request.model', value: { stringValue: 'gpt-4o-mini' } },
      { key: 'gen_ai.usage.input_tokens', value: { intValue: String(50 + (i % 400)) } },
      { key: 'gen_ai.usage.output_tokens', value: { intValue: String(20 + (i % 100)) } },
      { key: 'gen_ai.prompt', value: { stringValue: JSON.stringify([{ role: 'user', content: q }]) } },
      { key: 'gen_ai.completion', value: { stringValue: JSON.stringify([{ role: 'assistant', content: `Answer to: ${q.slice(0, 60)}` }]) } },
    ],
  };
  return s;
}

const spans = [];
for (let i = 0; i < N; i++) {
  spans.push(span(i));
  if (i % 10 === 7) {
    spans.push({
      traceId: String(i).padStart(32, '0'),
      spanId: 't' + String(i).padStart(15, '0'),
      parentSpanId: String(i).padStart(16, '0'),
      name: 'execute_tool search_docs',
      startTimeUnixNano: String(1752600000000000000 + i * 1e6 + 1e8),
      endTimeUnixNano: String(1752600000000000000 + i * 1e6 + 2e8),
      status: { code: 1 },
      attributes: [
        { key: 'gen_ai.operation.name', value: { stringValue: 'execute_tool' } },
        { key: 'gen_ai.tool.name', value: { stringValue: 'search_docs' } },
        { key: 'gen_ai.tool.call.arguments', value: { stringValue: `{"q":"widget ${i}"}` } },
        { key: 'gen_ai.tool.call.result', value: { stringValue: '{"hits":3}' } },
      ],
    });
  }
}

const doc = { resourceSpans: [{ resource: { attributes: [] }, scopeSpans: [{ scope: {}, spans }] }] };

// warmup
convert([doc]);

const t0 = process.hrtime.bigint();
const { cases, coverage } = convert([doc]);
const jsonl = toJsonl(cases);
const t1 = process.hrtime.bigint();

const ms = Number(t1 - t0) / 1e6;
const total = spans.length;
console.log(`trace2eval bench — Node ${process.version}`);
console.log(`spans: ${total} (incl. tool spans) → cases: ${cases.length} (${coverage.totals.duplicates_removed} dupes removed)`);
console.log(`convert+serialize: ${ms.toFixed(1)} ms  →  ${Math.round(total / (ms / 1000))} spans/s`);
console.log(`dataset size: ${(jsonl.length / 1024 / 1024).toFixed(2)} MiB`);
