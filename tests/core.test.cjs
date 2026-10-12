const test = require('node:test');
const assert = require('node:assert/strict');
const core = require('../dist/core.js');
const record = (id = 'r1', extra = {}) => ({ id, mode: 'see', title: '墙上的光', what: '光斑', createdAt: 1700000000000, ...extra });
test('single record id stays whole; ids deduplicate', () => {
  assert.deepEqual(core.ids('r123'), ['r123']);
  assert.deepEqual(core.ids(['r1', 'r1', 'r2']), ['r1', 'r2']);
});
test('draft fields support current and legacy nesting', () => {
  assert.equal(core.draftFields({ data: { data: { what: '叶子' }, photos: [] } }).what, '叶子');
  assert.equal(core.draftFields({ data: { what: '旧草稿' } }).what, '旧草稿');
});
test('search covers tags and supplemental fields', () => {
  assert.ok(core.search(record('r1', { memory: '童年的夏天' }), ' 夏天 '));
  assert.ok(core.search(record('r1', { clues: ['蓝色'] }), '蓝色'));
  assert.ok(core.search(record('r1', { bridge: 'Light' }), 'light'));
  assert.ok(!core.search(record(), '冬天'));
});
test('full backup keeps relations, creation drafts and record drafts', () => {
  const data = core.backup({ app: '灵感池塘', version: 2, records: [record(), record('r2')],
    links: { 'r2|r1': { type: '很相似', note: '光' } },
    creates: [{ id: 'c1', theme: '观察', sourceIds: ['r1'], spread: { '形态': ['圆'] }, chain: ['光'], reverse: [], converge: [3] }],
    drafts: [{ mode: 'see', data: { data: { what: '未完成' }, photos: [], board: '' } }] });
  assert.equal(data.links['r1|r2'].type, '很相似');
  assert.equal(data.creates[0].spread['形态'][0], '圆');
  assert.equal(data.drafts[0].data.data.what, '未完成');
});
test('v1 backup remains importable', () => {
  assert.equal(core.backup({ version: 1, records: [record('r1', { tags: ['旧标签'] })], links: [], creates: [] }).records[0].clues[0], '旧标签');
});
test('malformed ids, executable media, dates and foreign references are rejected', () => {
  assert.throws(() => core.backup({ records: [record('r" onclick="x')] }));
  assert.throws(() => core.backup({ records: [record('r1', { photos: ['x" onerror="alert(1)'] })] }));
  assert.throws(() => core.backup({ records: [record('r1', { photos: ['data:image/svg+xml;base64,PHN2Zz4='] })] }));
  assert.throws(() => core.backup({ records: [record('r1', { createdAt: 'yesterday' })] }));
  assert.throws(() => core.backup({ records: [record()], links: { 'r1|r9': {} } }));
  assert.throws(() => core.backup({ records: [record()], creates: [{ id: 'c1', sourceIds: ['r9'] }] }));
  assert.throws(() => core.backup({ version: 999, records: [] }));
});
test('duplicate ids and malformed drafts reject the entire backup', () => {
  assert.throws(() => core.backup({ records: [record(), record()] }));
  assert.throws(() => core.backup({ records: [record()], drafts: [{}] }));
  assert.throws(() => core.backup({ records: [record()], drafts: 'bad' }));
});
test('creation identity depends on the full set of source records', () => {
  assert.ok(core.sameIds(['r1', 'r2'], ['r2', 'r1']));
  assert.ok(!core.sameIds(['r1'], ['r2']));
});
