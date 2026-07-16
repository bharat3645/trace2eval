import { test } from 'node:test';
import assert from 'node:assert/strict';
import { caseId, canonicalInput, dedupeCases } from '../lib/dedupe.js';

function mkCase(content, role = 'user') {
  return {
    id: null,
    input: { messages: [{ role, content }] },
    expected: { role: 'assistant', content: 'x' },
    tools: [],
    meta: {},
  };
}

test('caseId is deterministic and whitespace-insensitive', () => {
  const a = mkCase('How do I reset my password?');
  const b = mkCase('How do I reset   my password?\n');
  assert.equal(caseId(a), caseId(b));
  assert.match(caseId(a), /^c-[0-9a-f]{12}$/);
});

test('caseId is case-sensitive (content casing matters for evals)', () => {
  assert.notEqual(caseId(mkCase('Hello')), caseId(mkCase('hello')));
});

test('canonicalInput includes roles and tool calls', () => {
  const plain = mkCase('do it');
  const withTool = mkCase('do it');
  withTool.input.messages.push({
    role: 'assistant',
    content: '',
    tool_calls: [{ id: '1', name: 'run', arguments: { x: 1 } }],
  });
  assert.notEqual(canonicalInput(plain), canonicalInput(withTool));
});

test('dedupeCases keeps first occurrence, reports drops', () => {
  const first = mkCase('same question');
  first.marker = 'first';
  const second = mkCase('same  question'); // whitespace variant
  const third = mkCase('different question');
  const { kept, dropped } = dedupeCases([first, second, third]);
  assert.equal(kept.length, 2);
  assert.equal(dropped, 1);
  assert.equal(kept[0].marker, 'first');
  assert.ok(kept.every((c) => c.id));
});

test('keepDuplicates keeps all and disambiguates ids', () => {
  const { kept, dropped } = dedupeCases([mkCase('q'), mkCase('q'), mkCase('q')], { keepDuplicates: true });
  assert.equal(kept.length, 3);
  assert.equal(dropped, 0);
  assert.equal(new Set(kept.map((c) => c.id)).size, 3);
  assert.ok(kept[1].id.endsWith('-2'));
  assert.ok(kept[2].id.endsWith('-3'));
});
