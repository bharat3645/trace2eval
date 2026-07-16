// extract.js — turn normalized GenAI spans into eval cases.
// Supports the content encodings seen across OTel GenAI semconv revisions:
//   1. span attrs  gen_ai.input.messages / gen_ai.output.messages (JSON)
//   2. span attrs  gen_ai.prompt / gen_ai.completion (JSON array or string)
//   3. indexed     gen_ai.prompt.0.role / gen_ai.prompt.0.content / …
//   4. span events gen_ai.content.prompt / gen_ai.content.completion
//   5. span events gen_ai.system.message / gen_ai.user.message /
//                  gen_ai.assistant.message / gen_ai.tool.message / gen_ai.choice

'use strict';

import { isToolSpan } from './otel.js';

function tryJson(s) {
  if (typeof s !== 'string') return s;
  const t = s.trim();
  if (!t.startsWith('{') && !t.startsWith('[')) return s;
  try {
    return JSON.parse(t);
  } catch {
    return s;
  }
}

function contentToString(c) {
  if (c === null || c === undefined) return '';
  if (typeof c === 'string') return c;
  if (Array.isArray(c)) {
    // parts array: [{type:"text", content|text: "..."}, ...]
    return c
      .map((p) => {
        if (typeof p === 'string') return p;
        if (p && typeof p === 'object') return p.content ?? p.text ?? '';
        return '';
      })
      .filter((s) => s !== '')
      .join('\n');
  }
  if (typeof c === 'object') return c.content ?? c.text ?? JSON.stringify(c);
  return String(c);
}

function normalizeMessage(m, fallbackRole) {
  if (m === null || m === undefined) return null;
  if (typeof m === 'string') {
    return { role: fallbackRole || 'user', content: m };
  }
  const role = m.role || fallbackRole || 'user';
  const out = { role, content: contentToString(m.content ?? m.parts ?? m.text ?? '') };
  const toolCalls = m.tool_calls ?? m.toolCalls;
  if (Array.isArray(toolCalls) && toolCalls.length > 0) {
    out.tool_calls = toolCalls.map((tc) => ({
      id: tc.id ?? null,
      name: tc.function?.name ?? tc.name ?? null,
      arguments: tryJson(tc.function?.arguments ?? tc.arguments ?? null),
    }));
  }
  if (m.tool_call_id) out.tool_call_id = m.tool_call_id;
  return out;
}

function messagesFromValue(value, fallbackRole) {
  const parsed = tryJson(value);
  if (Array.isArray(parsed)) {
    return parsed.map((m) => normalizeMessage(m, fallbackRole)).filter(Boolean);
  }
  if (parsed && typeof parsed === 'object') {
    const one = normalizeMessage(parsed, fallbackRole);
    return one ? [one] : [];
  }
  if (typeof parsed === 'string' && parsed.length > 0) {
    return [{ role: fallbackRole || 'user', content: parsed }];
  }
  return [];
}

function indexedMessages(attrs, prefix) {
  const out = [];
  for (let i = 0; ; i++) {
    const role = attrs[`${prefix}.${i}.role`];
    const content = attrs[`${prefix}.${i}.content`];
    if (role === undefined && content === undefined) break;
    out.push(normalizeMessage({ role: role || (prefix.endsWith('completion') ? 'assistant' : 'user'), content: content ?? '' }));
  }
  return out;
}

const MESSAGE_EVENT_ROLES = {
  'gen_ai.system.message': 'system',
  'gen_ai.user.message': 'user',
  'gen_ai.assistant.message': 'assistant',
  'gen_ai.tool.message': 'tool',
};

function messagesFromEvents(span) {
  const input = [];
  const output = [];
  for (const ev of span.events) {
    if (ev.name === 'gen_ai.content.prompt') {
      input.push(...messagesFromValue(ev.attributes['gen_ai.prompt'] ?? ev.attributes.body, 'user'));
    } else if (ev.name === 'gen_ai.content.completion') {
      output.push(...messagesFromValue(ev.attributes['gen_ai.completion'] ?? ev.attributes.body, 'assistant'));
    } else if (ev.name in MESSAGE_EVENT_ROLES) {
      const role = MESSAGE_EVENT_ROLES[ev.name];
      const body = ev.attributes.body ?? ev.attributes.content ?? ev.attributes;
      const parsed = typeof body === 'string' ? tryJson(body) : body;
      const msg = normalizeMessage(
        typeof parsed === 'object' && parsed !== null ? { role, ...parsed } : { role, content: parsed },
        role
      );
      if (msg && (msg.content || msg.tool_calls)) {
        if (role === 'assistant') output.push(msg);
        else input.push(msg);
      }
    } else if (ev.name === 'gen_ai.choice') {
      const body = ev.attributes.body ?? ev.attributes.message ?? ev.attributes;
      const parsed = typeof body === 'string' ? tryJson(body) : body;
      const inner = parsed && typeof parsed === 'object' ? parsed.message ?? parsed : parsed;
      const msg = normalizeMessage(
        typeof inner === 'object' && inner !== null ? { role: 'assistant', ...inner } : { role: 'assistant', content: inner }
      );
      if (msg && (msg.content || msg.tool_calls)) output.push(msg);
    }
  }
  return { input, output };
}

/** Extract {input, output} message arrays from a span, across semconv styles. */
export function extractMessages(span) {
  const a = span.attributes;

  let input = [];
  if (a['gen_ai.input.messages'] !== undefined) input = messagesFromValue(a['gen_ai.input.messages'], 'user');
  if (input.length === 0 && a['gen_ai.prompt'] !== undefined) input = messagesFromValue(a['gen_ai.prompt'], 'user');
  if (input.length === 0) input = indexedMessages(a, 'gen_ai.prompt');

  let output = [];
  if (a['gen_ai.output.messages'] !== undefined) output = messagesFromValue(a['gen_ai.output.messages'], 'assistant');
  if (output.length === 0 && a['gen_ai.completion'] !== undefined) output = messagesFromValue(a['gen_ai.completion'], 'assistant');
  if (output.length === 0) output = indexedMessages(a, 'gen_ai.completion');

  if (input.length === 0 || output.length === 0) {
    const fromEvents = messagesFromEvents(span);
    if (input.length === 0) input = fromEvents.input;
    if (output.length === 0) output = fromEvents.output;
  }

  return { input, output };
}

function usageFromAttrs(a) {
  const inputTokens = a['gen_ai.usage.input_tokens'] ?? a['gen_ai.usage.prompt_tokens'] ?? null;
  const outputTokens = a['gen_ai.usage.output_tokens'] ?? a['gen_ai.usage.completion_tokens'] ?? null;
  if (inputTokens === null && outputTokens === null) return null;
  return {
    input_tokens: inputTokens === null ? null : Number(inputTokens),
    output_tokens: outputTokens === null ? null : Number(outputTokens),
  };
}

function toolRecordFromSpan(span) {
  const a = span.attributes;
  return {
    name: a['gen_ai.tool.name'] ?? span.name ?? null,
    call_id: a['gen_ai.tool.call.id'] ?? null,
    arguments: tryJson(a['gen_ai.tool.call.arguments'] ?? a['gen_ai.tool.input'] ?? null),
    result: tryJson(a['gen_ai.tool.call.result'] ?? a['gen_ai.tool.output'] ?? null),
    status: span.status,
  };
}

/**
 * Convert flattened spans into eval cases.
 * Returns { cases, stats } where stats counts skips by reason.
 * Tool spans (execute_tool) are attached to their parent inference span by
 * parentSpanId; if no parent matches, by traceId when the trace contains
 * exactly one inference case.
 */
export function spansToCases(spans) {
  const stats = {
    spans_total: spans.length,
    genai_spans: 0,
    tool_spans: 0,
    cases: 0,
    skipped_no_input: 0,
    skipped_no_output: 0,
    skipped_error: 0,
  };

  const inferenceSpans = [];
  const toolSpans = [];
  for (const span of spans) {
    const hasGenAi =
      Object.keys(span.attributes).some((k) => k.startsWith('gen_ai.')) ||
      span.events.some(
        (ev) => ev.name.startsWith('gen_ai.') || Object.keys(ev.attributes).some((k) => k.startsWith('gen_ai.'))
      );
    if (!hasGenAi) continue;
    stats.genai_spans++;
    if (isToolSpan(span)) {
      stats.tool_spans++;
      toolSpans.push(span);
    } else {
      inferenceSpans.push(span);
    }
  }

  const cases = [];
  const caseBySpanId = new Map();
  const casesByTraceId = new Map();

  for (const span of inferenceSpans) {
    const a = span.attributes;
    if (span.status === 'error') {
      stats.skipped_error++;
      continue;
    }
    const { input, output } = extractMessages(span);
    if (input.length === 0) {
      stats.skipped_no_input++;
      continue;
    }
    if (output.length === 0) {
      stats.skipped_no_output++;
      continue;
    }
    const c = {
      id: null, // assigned after scrub+dedupe (content hash)
      input: { messages: input },
      expected: output.length === 1 ? output[0] : { role: 'assistant', content: '', messages: output },
      tools: [],
      meta: {
        model: a['gen_ai.response.model'] ?? a['gen_ai.request.model'] ?? null,
        system: a['gen_ai.system'] ?? a['gen_ai.provider.name'] ?? null,
        operation: a['gen_ai.operation.name'] ?? null,
        trace_id: span.traceId || null,
        span_id: span.spanId || null,
        start_ms: span.startMs,
        latency_ms: span.durationMs,
        usage: usageFromAttrs(a),
        status: span.status,
      },
    };
    cases.push(c);
    if (span.spanId) caseBySpanId.set(span.spanId, c);
    if (span.traceId) {
      if (!casesByTraceId.has(span.traceId)) casesByTraceId.set(span.traceId, []);
      casesByTraceId.get(span.traceId).push(c);
    }
  }

  for (const t of toolSpans) {
    const rec = toolRecordFromSpan(t);
    let target = t.parentSpanId ? caseBySpanId.get(t.parentSpanId) : undefined;
    if (!target && t.traceId) {
      const inTrace = casesByTraceId.get(t.traceId);
      if (inTrace && inTrace.length === 1) target = inTrace[0];
    }
    if (target) target.tools.push(rec);
  }

  stats.cases = cases.length;
  return { cases, stats };
}
