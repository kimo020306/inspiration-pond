const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { IDBFactory } = require('fake-indexeddb');
function database() {
  const context = vm.createContext({ indexedDB: new IDBFactory(), PondCore: require('../dist/core.js') });
  vm.runInContext(fs.readFileSync(require.resolve('../dist/database.js'), 'utf8') + '\n globalThis.api = store;', context);
  return context.api;
}
const record = (id, title = id) => ({ id, title, mode: 'see', what: title, createdAt: 1700000000000 });
test('operations wait for the database even before initialization', async () => {
  const store = database();
  await Promise.all([store.put(record('r1')), store.put(record('r2'))]);
  assert.equal((await store.all()).length, 2);
});
test('import restores all data and preserves local records and relations on repeat', async () => {
  const store = database();
  await store.put(record('r1', '本地修改'));
  await store.saveLinks({ 'r1|r2': { type: '本地关联' } });
  const backup = { records: [record('r1', '旧备份'), record('r2')], links: { 'r1|r2': { type: '旧关联' } },
    creates: [{ id: 'c1', sourceIds: ['r1', 'r2'], theme: '作品' }],
    drafts: [{ mode: 'feel', data: { data: { feel: '平静' }, photos: [] } }] };
  const result = await store.importBackup(backup);
  assert.equal(result.added, 1); assert.equal(result.skipped, 1);
  assert.equal((await store.get('r1')).title, '本地修改');
  assert.equal((await store.allLinks())['r1|r2'].type, '本地关联');
  assert.equal((await store.allCreates())[0].theme, '作品');
  assert.equal((await store.getDraft('feel')).data.data.feel, '平静');
  assert.equal((await store.importBackup(backup)).added, 0);
});
test('invalid later record cannot cause a partial import', async () => {
  const store = database();
  await store.put(record('r0'));
  await assert.rejects(store.importBackup({ records: [record('r1'), { id: 'r2', mode: 'bad' }] }));
  assert.equal((await store.all()).length, 1);
  assert.equal(await store.get('r1'), undefined);
});
