// convert.js — the full pipeline: trace documents → eval dataset + coverage.
// parse → flatten spans → extract cases → scrub PII → dedupe → coverage map.

'use strict';

import { flattenSpans } from './otel.js';
import { spansToCases } from './extract.js';
import { scrubCase } from './scrub.js';
import { dedupeCases } from './dedupe.js';
import { buildCoverage } from './coverage.js';

/**
 * @param docs    array of parsed trace documents (OTLP/JSON, {spans}, or array)
 * @param options { scrub = true, keepDuplicates = false }
 * @returns { cases, coverage, stats }
 */
export function convert(docs, options = {}) {
  const { scrub = true, keepDuplicates = false } = options;

  const spans = [];
  for (const doc of docs) spans.push(...flattenSpans(doc));

  const { cases, stats } = spansToCases(spans);

  const scrubTotals = Object.create(null);
  if (scrub) {
    for (const c of cases) {
      const counts = scrubCase(c);
      if (counts) {
        c.meta.scrubbed = counts;
        for (const [type, n] of Object.entries(counts)) {
          scrubTotals[type] = (scrubTotals[type] || 0) + n;
        }
      }
    }
  }

  const { kept, dropped } = dedupeCases(cases, { keepDuplicates });

  const coverage = buildCoverage(kept, stats, {
    duplicates_removed: dropped,
    scrub_counts: { ...scrubTotals },
  });

  return { cases: kept, coverage, stats };
}

/** Serialize cases as JSONL (one case per line, trailing newline). */
export function toJsonl(cases) {
  if (cases.length === 0) return '';
  return cases.map((c) => JSON.stringify(c)).join('\n') + '\n';
}
