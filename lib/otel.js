// otel.js — parse OTLP/JSON trace exports into flat, plain-object spans.
// Zero dependencies. Handles the OTLP JSON encoding (resourceSpans →
// scopeSpans → spans, attributes as {key, value:{stringValue|intValue|…}})
// as well as pre-flattened shapes ({spans:[…]} or a bare array of spans).

'use strict';

/**
 * Convert an OTLP AnyValue ({stringValue}|{intValue}|{doubleValue}|
 * {boolValue}|{arrayValue}|{kvlistValue}|{bytesValue}) to a plain JS value.
 * Already-plain values pass through untouched.
 */
export function anyValueToJs(v) {
  if (v === null || v === undefined) return v;
  if (typeof v !== 'object') return v;
  if ('stringValue' in v) return v.stringValue;
  if ('intValue' in v) {
    const n = Number(v.intValue);
    return Number.isSafeInteger(n) ? n : String(v.intValue);
  }
  if ('doubleValue' in v) return Number(v.doubleValue);
  if ('boolValue' in v) return Boolean(v.boolValue);
  if ('bytesValue' in v) return String(v.bytesValue);
  if ('arrayValue' in v) {
    const vals = (v.arrayValue && v.arrayValue.values) || [];
    return vals.map(anyValueToJs);
  }
  if ('kvlistValue' in v) {
    const out = {};
    for (const kv of (v.kvlistValue && v.kvlistValue.values) || []) {
      out[kv.key] = anyValueToJs(kv.value);
    }
    return out;
  }
  return v; // plain object (already decoded)
}

/**
 * Convert an OTLP attribute list ([{key, value}]) or a plain object into a
 * plain {key: value} object.
 */
export function attrsToObject(attrs) {
  if (!attrs) return {};
  if (Array.isArray(attrs)) {
    const out = {};
    for (const a of attrs) {
      if (a && typeof a.key === 'string') out[a.key] = anyValueToJs(a.value);
    }
    return out;
  }
  if (typeof attrs === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(attrs)) out[k] = anyValueToJs(v);
    return out;
  }
  return {};
}

function nanosToBigInt(nanos) {
  if (nanos === null || nanos === undefined || nanos === '') return null;
  try {
    return BigInt(nanos);
  } catch {
    return null;
  }
}

function nanosToMs(nanos) {
  const b = nanosToBigInt(nanos);
  if (b === null) return null;
  return Number(b) / 1e6;
}

function normalizeStatus(status) {
  if (!status || typeof status !== 'object') return 'unset';
  const code = status.code;
  if (code === 2 || code === 'STATUS_CODE_ERROR' || code === 'ERROR') return 'error';
  if (code === 1 || code === 'STATUS_CODE_OK' || code === 'OK') return 'ok';
  return 'unset';
}

function normalizeSpan(raw, resourceAttrs) {
  const attributes = attrsToObject(raw.attributes);
  const events = [];
  for (const ev of raw.events || []) {
    events.push({
      name: ev.name || '',
      timeMs: nanosToMs(ev.timeUnixNano),
      attributes: attrsToObject(ev.attributes),
    });
  }
  const startBig = nanosToBigInt(raw.startTimeUnixNano);
  const endBig = nanosToBigInt(raw.endTimeUnixNano);
  const startMs = startBig === null ? null : Number(startBig) / 1e6;
  const endMs = endBig === null ? null : Number(endBig) / 1e6;
  // duration via BigInt subtraction: exact even when absolute nanos > 2^53
  const durationMs = startBig !== null && endBig !== null ? Math.max(0, Number(endBig - startBig) / 1e6) : null;
  return {
    traceId: raw.traceId || '',
    spanId: raw.spanId || '',
    parentSpanId: raw.parentSpanId || '',
    name: raw.name || '',
    startMs,
    endMs,
    durationMs,
    status: normalizeStatus(raw.status),
    attributes,
    events,
    resource: resourceAttrs || {},
  };
}

/**
 * Flatten a parsed trace document into an array of normalized spans.
 * Accepts:
 *  - OTLP/JSON export: { resourceSpans: [...] }
 *  - pre-flattened:    { spans: [...] }
 *  - bare array:       [ span, span, ... ]
 * Throws TypeError on unrecognized shapes.
 */
export function flattenSpans(doc) {
  if (Array.isArray(doc)) {
    return doc.map((s) => normalizeSpan(s, attrsToObject(s.resource && s.resource.attributes)));
  }
  if (doc && typeof doc === 'object') {
    if (Array.isArray(doc.resourceSpans)) {
      const out = [];
      for (const rs of doc.resourceSpans) {
        const resourceAttrs = attrsToObject(rs.resource && rs.resource.attributes);
        for (const ss of rs.scopeSpans || rs.instrumentationLibrarySpans || []) {
          for (const span of ss.spans || []) {
            out.push(normalizeSpan(span, resourceAttrs));
          }
        }
      }
      return out;
    }
    if (Array.isArray(doc.spans)) {
      return doc.spans.map((s) => normalizeSpan(s, attrsToObject(doc.resource && doc.resource.attributes)));
    }
  }
  throw new TypeError(
    'Unrecognized trace document: expected OTLP/JSON ({resourceSpans:[…]}), {spans:[…]}, or an array of spans'
  );
}

/** True if the span carries any GenAI semantic-convention data. */
export function isGenAiSpan(span) {
  for (const k of Object.keys(span.attributes)) {
    if (k.startsWith('gen_ai.')) return true;
  }
  for (const ev of span.events) {
    if (ev.name.startsWith('gen_ai.')) return true;
    for (const k of Object.keys(ev.attributes)) {
      if (k.startsWith('gen_ai.')) return true;
    }
  }
  return false;
}

/** True for tool-execution spans (gen_ai.operation.name = execute_tool). */
export function isToolSpan(span) {
  return span.attributes['gen_ai.operation.name'] === 'execute_tool';
}
