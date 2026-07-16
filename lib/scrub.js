// scrub.js — PII/secret scrubbing with stable, typed placeholders.
// Same detected value gets the same placeholder within one case
// (e.g. every "alice@example.com" → "<EMAIL_1>"), so multi-turn
// conversations stay internally consistent after scrubbing.
//
// Detectors (applied in this order — most specific first):
//   JWT, API_KEY, CREDIT_CARD (Luhn-validated), SSN, EMAIL, IP, PHONE

'use strict';

function luhnOk(digits) {
  let sum = 0;
  let dbl = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let d = digits.charCodeAt(i) - 48;
    if (dbl) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
    dbl = !dbl;
  }
  return sum % 10 === 0;
}

const DETECTORS = [
  {
    type: 'JWT',
    re: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g,
  },
  {
    type: 'API_KEY',
    re: /\b(?:sk-[A-Za-z0-9_-]{20,}|ghp_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{22,}|AKIA[0-9A-Z]{16}|xox[baprs]-[A-Za-z0-9-]{10,}|gsk_[A-Za-z0-9]{20,})\b/g,
  },
  {
    type: 'API_KEY',
    re: /\b[Bb]earer\s+[A-Za-z0-9._~+/-]{16,}=*/g,
  },
  {
    type: 'CREDIT_CARD',
    re: /\b\d(?:[ -]?\d){12,18}\b/g,
    validate: (m) => {
      const digits = m.replace(/[ -]/g, '');
      return digits.length >= 13 && digits.length <= 19 && luhnOk(digits);
    },
  },
  {
    type: 'SSN',
    re: /\b\d{3}-\d{2}-\d{4}\b/g,
  },
  {
    type: 'EMAIL',
    re: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g,
  },
  {
    type: 'IP',
    re: /\b(?:\d{1,3}\.){3}\d{1,3}\b/g,
    validate: (m) => m.split('.').every((o) => Number(o) <= 255),
  },
  {
    type: 'PHONE',
    // separators: space/dash/parens only ("." would eat decimals & versions);
    // leading "." also blocked so decimal fractions never match
    re: /(?<![\w.])(?:\+\d{1,3}[-\s]?)?(?:\(\d{2,4}\)[-\s]?)?\d{2,4}(?:[-\s]?\d{3,4}){1,3}(?!\w)/g,
    validate: (m) => {
      const digits = m.replace(/\D/g, '');
      return digits.length >= 10 && digits.length <= 15;
    },
  },
];

/** Create a scrub state: stable value→placeholder map + per-type counters. */
export function createScrubState() {
  return { map: new Map(), counters: Object.create(null), counts: Object.create(null) };
}

function placeholderFor(state, type, value) {
  const key = `${type} ${value}`;
  let ph = state.map.get(key);
  if (!ph) {
    state.counters[type] = (state.counters[type] || 0) + 1;
    ph = `<${type}_${state.counters[type]}>`;
    state.map.set(key, ph);
  }
  return ph;
}

/**
 * Scrub one string. Returns the scrubbed string; occurrence counts accumulate
 * in state.counts (per type).
 */
export function scrubText(text, state) {
  if (typeof text !== 'string' || text.length === 0) return text;
  let out = text;
  for (const det of DETECTORS) {
    out = out.replace(det.re, (m) => {
      if (det.validate && !det.validate(m)) return m;
      state.counts[det.type] = (state.counts[det.type] || 0) + 1;
      return placeholderFor(state, det.type, m);
    });
  }
  return out;
}

function scrubDeep(value, state) {
  if (typeof value === 'string') return scrubText(value, state);
  if (Array.isArray(value)) return value.map((v) => scrubDeep(v, state));
  if (value && typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = scrubDeep(v, state);
    return out;
  }
  return value;
}

/**
 * Scrub an eval case in place: all message contents, tool-call arguments,
 * tool results. Returns per-type counts found in this case (or null if none).
 * Placeholders are stable within the case.
 */
export function scrubCase(c) {
  const state = createScrubState();
  for (const msg of c.input.messages) {
    msg.content = scrubText(msg.content, state);
    if (msg.tool_calls) msg.tool_calls = scrubDeep(msg.tool_calls, state);
  }
  if (c.expected) {
    if (typeof c.expected.content === 'string') c.expected.content = scrubText(c.expected.content, state);
    if (Array.isArray(c.expected.messages)) c.expected.messages = scrubDeep(c.expected.messages, state);
    if (c.expected.tool_calls) c.expected.tool_calls = scrubDeep(c.expected.tool_calls, state);
  }
  if (Array.isArray(c.tools) && c.tools.length > 0) {
    c.tools = c.tools.map((t) => ({ ...t, arguments: scrubDeep(t.arguments, state), result: scrubDeep(t.result, state) }));
  }
  const types = Object.keys(state.counts);
  return types.length > 0 ? { ...state.counts } : null;
}
