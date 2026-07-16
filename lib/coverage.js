// coverage.js — what slice of production traffic does this eval set cover?
// Builds a coverage map over the final (post-scrub, post-dedupe) cases plus
// extraction stats, so gaps are visible: models with no cases, error rates,
// tool paths never exercised, token-length skew.

'use strict';

const TOKEN_BUCKETS = [
  [0, 100, '0-100'],
  [101, 500, '101-500'],
  [501, 2000, '501-2000'],
  [2001, 8000, '2001-8000'],
  [8001, Infinity, '8001+'],
];

function bucketFor(tokens) {
  for (const [lo, hi, label] of TOKEN_BUCKETS) {
    if (tokens >= lo && tokens <= hi) return label;
  }
  return 'unknown';
}

function inc(obj, key) {
  const k = key === null || key === undefined || key === '' ? 'unknown' : String(key);
  obj[k] = (obj[k] || 0) + 1;
}

/**
 * Build the coverage map.
 * @param cases   final eval cases
 * @param stats   extraction stats from spansToCases
 * @param extras  { duplicates_removed, scrub_counts }
 */
export function buildCoverage(cases, stats, extras = {}) {
  const cov = {
    generated_at: new Date().toISOString(),
    totals: {
      spans_seen: stats.spans_total,
      genai_spans: stats.genai_spans,
      tool_spans: stats.tool_spans,
      cases: cases.length,
      duplicates_removed: extras.duplicates_removed || 0,
      skipped_no_input: stats.skipped_no_input,
      skipped_no_output: stats.skipped_no_output,
      skipped_error: stats.skipped_error,
      cases_scrubbed: 0,
      scrub_counts: extras.scrub_counts || {},
    },
    by_model: {},
    by_system: {},
    by_operation: {},
    tools: { cases_with_tools: 0, by_tool: {} },
    input_token_buckets: {},
    multi_turn: { single_turn: 0, multi_turn: 0 },
    time_range: { first_ms: null, last_ms: null },
  };

  for (const c of cases) {
    inc(cov.by_model, c.meta.model);
    inc(cov.by_system, c.meta.system);
    inc(cov.by_operation, c.meta.operation);

    if (c.tools && c.tools.length > 0) {
      cov.tools.cases_with_tools++;
      for (const t of c.tools) inc(cov.tools.by_tool, t.name);
    }
    for (const m of c.input.messages) {
      if (m.tool_calls) for (const tc of m.tool_calls) inc(cov.tools.by_tool, tc.name);
    }
    if (c.expected && c.expected.tool_calls) {
      for (const tc of c.expected.tool_calls) inc(cov.tools.by_tool, tc.name);
    }

    const inTokens = c.meta.usage && c.meta.usage.input_tokens;
    inc(cov.input_token_buckets, typeof inTokens === 'number' ? bucketFor(inTokens) : 'unknown');

    const userTurns = c.input.messages.filter((m) => m.role === 'user').length;
    if (userTurns > 1) cov.multi_turn.multi_turn++;
    else cov.multi_turn.single_turn++;

    if (c.meta.scrubbed) cov.totals.cases_scrubbed++;

    if (typeof c.meta.start_ms === 'number') {
      if (cov.time_range.first_ms === null || c.meta.start_ms < cov.time_range.first_ms) {
        cov.time_range.first_ms = c.meta.start_ms;
      }
      if (cov.time_range.last_ms === null || c.meta.start_ms > cov.time_range.last_ms) {
        cov.time_range.last_ms = c.meta.start_ms;
      }
    }
  }

  return cov;
}

/** Short human summary of a coverage map (for stderr). */
export function coverageSummary(cov) {
  const t = cov.totals;
  const lines = [];
  lines.push(
    `cases: ${t.cases}  (from ${t.genai_spans} GenAI spans / ${t.spans_seen} total; ` +
      `${t.duplicates_removed} duplicate${t.duplicates_removed === 1 ? '' : 's'} removed, ` +
      `${t.skipped_no_output + t.skipped_no_input} incomplete, ${t.skipped_error} errored skipped)`
  );
  const scrubTotal = Object.values(t.scrub_counts).reduce((a, b) => a + b, 0);
  if (scrubTotal > 0) {
    const detail = Object.entries(t.scrub_counts)
      .map(([k, v]) => `${k}:${v}`)
      .join(' ');
    lines.push(`scrubbed: ${scrubTotal} PII/secret value${scrubTotal === 1 ? '' : 's'} in ${t.cases_scrubbed} case${t.cases_scrubbed === 1 ? '' : 's'} (${detail})`);
  } else {
    lines.push('scrubbed: nothing detected');
  }
  const models = Object.entries(cov.by_model)
    .sort((a, b) => b[1] - a[1])
    .map(([k, v]) => `${k}:${v}`)
    .join(' ');
  lines.push(`models: ${models || 'none'}`);
  const tools = Object.entries(cov.tools.by_tool)
    .sort((a, b) => b[1] - a[1])
    .map(([k, v]) => `${k}:${v}`)
    .join(' ');
  lines.push(`tools: ${cov.tools.cases_with_tools} case(s) with tool activity${tools ? ` (${tools})` : ''}`);
  return lines.join('\n');
}
