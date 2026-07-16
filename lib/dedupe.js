// dedupe.js — deterministic case IDs + input-level deduplication.
// Production traces repeat the same prompt thousands of times; an eval set
// wants each distinct input once. Canonicalization collapses whitespace but
// preserves case and punctuation (they matter for evals).

'use strict';

import { createHash } from 'node:crypto';

function canonContent(s) {
  if (typeof s !== 'string') return '';
  return s.replace(/\s+/g, ' ').trim();
}

function canonMessage(m) {
  const out = [m.role || '', canonContent(m.content)];
  if (m.tool_calls) {
    out.push(
      m.tool_calls
        .map((tc) => `${tc.name || ''}(${typeof tc.arguments === 'string' ? canonContent(tc.arguments) : JSON.stringify(tc.arguments)})`)
        .join(',')
    );
  }
  return out.join(' ');
}

/** Canonical string form of a case input (messages only, not metadata). */
export function canonicalInput(c) {
  return c.input.messages.map(canonMessage).join('');
}

/** Stable content-hash ID for a case: "c-" + first 12 hex of sha256(input). */
export function caseId(c) {
  return 'c-' + createHash('sha256').update(canonicalInput(c), 'utf8').digest('hex').slice(0, 12);
}

/**
 * Assign IDs and drop duplicate inputs (keeps the first occurrence — stable
 * and deterministic across runs). Returns { kept, dropped }.
 */
export function dedupeCases(cases, { keepDuplicates = false } = {}) {
  const seen = new Map();
  const kept = [];
  let dropped = 0;
  for (const c of cases) {
    c.id = caseId(c);
    if (keepDuplicates) {
      const n = (seen.get(c.id) || 0) + 1;
      seen.set(c.id, n);
      if (n > 1) c.id = `${c.id}-${n}`;
      kept.push(c);
      continue;
    }
    if (seen.has(c.id)) {
      dropped++;
      continue;
    }
    seen.set(c.id, 1);
    kept.push(c);
  }
  return { kept, dropped };
}
