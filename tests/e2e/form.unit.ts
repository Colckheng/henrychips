import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ToolDescription } from '../../src/contracts/tool.js';
import { initialValues, serializeInput } from '../../src/web/form.js';

const tool: ToolDescription = {
  name: 'schema_test', title: 'Schema test', description: '', category: 'data', capabilities: [],
  fields: [
    { name: 'path', label: 'Path', type: 'relative-path' },
    { name: 'start', label: 'Start', type: 'number' },
    { name: 'end', label: 'End', type: 'number' },
    { name: 'note', label: 'Note', type: 'text' },
    { name: 'enabled', label: 'Enabled', type: 'checkbox' },
  ],
  examples: [], outputSchema: {},
  inputSchema: { type: 'object', required: ['path', 'start'], properties: {
    path: { type: 'string' }, start: { type: 'number', default: 1 },
    end: { type: 'number' }, note: { type: 'string' }, enabled: { type: 'boolean', default: true },
  } },
};

test('schema defaults initialize the form including booleans', () => {
  assert.deepEqual(initialValues(tool), { path: '', start: 1, end: '', note: '', enabled: true });
});

test('optional blank strings and numbers are omitted while zero and false survive', () => {
  assert.deepEqual(serializeInput(tool, { path: 'samples/guide.pdf', start: '0', end: '', note: '  ', enabled: false }),
    { path: 'samples/guide.pdf', start: 0, enabled: false });
});

test('required empty fields remain present for validation', () => {
  assert.deepEqual(serializeInput(tool, { path: '', start: '', end: '', note: '', enabled: true }),
    { path: '', start: '', enabled: true });
});

test('example replacement removes stale optional values and retains defaults', () => {
  assert.deepEqual(initialValues(tool, { path: 'new.pdf' }),
    { path: 'new.pdf', start: 1, end: '', note: '', enabled: true });
});

test('text is preserved verbatim and undeclared input is never sent', () => {
  assert.deepEqual(serializeInput(tool, { path: 'file.pdf', start: 1, note: ' A\n中 ', enabled: true, extra: 'drop' }),
    { path: 'file.pdf', start: 1, note: ' A\n中 ', enabled: true });
});

const listTool: ToolDescription = {
  ...tool,
  name: 'list_test',
  fields: [
    { name: 'path', label: 'Path', type: 'relative-path' },
    { name: 'paths', label: 'Paths', type: 'textarea' },
  ],
  inputSchema: { type: 'object', required: ['path'], properties: {
    path: { type: 'string' }, paths: { type: 'array', items: { type: 'string' } },
  } },
};

test('a textarea of a list is sent as the list of its lines', () => {
  assert.deepEqual(serializeInput(listTool, { path: 'a.pdf', paths: 'first.txt\nsecond.txt' }),
    { path: 'a.pdf', paths: ['first.txt', 'second.txt'] });
});

test('a blank textarea of a list is omitted instead of sent as an empty list', () => {
  assert.deepEqual(serializeInput(listTool, { path: 'a.pdf', paths: '  \n ' }), { path: 'a.pdf' });
});
