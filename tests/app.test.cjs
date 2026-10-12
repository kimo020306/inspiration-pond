const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { JSDOM, VirtualConsole } = require('jsdom');
const { IDBFactory } = require('fake-indexeddb');
const root = path.resolve(__dirname, '../dist');
function app(t) {
  const dom = new JSDOM(fs.readFileSync(path.join(root, 'index.html'), 'utf8'), { url: 'https://pond.test/', runScripts: 'outside-only', virtualConsole: new VirtualConsole() });
  const win = dom.window;
  win.indexedDB = new IDBFactory();
  win.scrollTo = () => {};
  win.matchMedia = () => ({ matches: false });
  win.confirm = () => true;
  const context = new Proxy({}, { get: (_, key) => key === 'measureText' ? text => ({ width: String(text).length * 10 }) : () => {}, set: () => true });
  win.HTMLCanvasElement.prototype.getContext = () => context;
  win.HTMLCanvasElement.prototype.toDataURL = () => 'data:image/jpeg;base64,YQ==';
  for (const file of ['core.js', 'database.js', 'app.js']) vm.runInContext(fs.readFileSync(path.join(root, file), 'utf8'), dom.getInternalVMContext(), { filename: file });
  t.after(() => win.close());
  return { win, store: win.eval('store'), el: selector => win.document.querySelector(selector) };
}
const record = (id, mode = 'see') => ({ id, mode, title: id, what: '光', photos: [], boardEmpty: true, createdAt: 1700000000000 });
test('form restores words, photos and sketch from nested draft', async t => {
  const a = app(t);
  await a.store.putDraft('see', { data: { what: '树叶的影子' }, photos: ['data:image/jpeg;base64,YQ=='], board: 'data:image/jpeg;base64,YQ==' });
  await a.win.openForm('see');
  assert.equal(a.el('[data-field="what"]').value, '树叶的影子');
  assert.equal(a.win.eval('photos.length'), 1);
  assert.equal(a.win.eval('boardRef.isEmpty()'), false);
  assert.equal(a.el('[data-target="draw"]').getAttribute('aria-expanded'), 'true');
});
test('switching entry mode clears previous photos and canvas', async t => {
  const a = app(t);
  await a.store.putDraft('see', { data: { what: '光' }, photos: ['data:image/jpeg;base64,YQ=='], board: 'data:image/jpeg;base64,YQ==' });
  await a.win.openForm('see');
  await a.win.openForm('feel');
  assert.equal(a.win.eval('photos.length'), 0);
  assert.equal(a.win.eval('boardRef'), null);
  assert.equal(a.el('[data-field="feel"]').value, '');
});
test('double save creates one record and clears pending draft', async t => {
  const a = app(t);
  await a.win.openForm('see');
  a.el('[data-field="what"]').value = '窗边';
  a.win.autosave();
  await Promise.all([a.win.saveRecord(), a.win.saveRecord()]);
  assert.equal((await a.store.all()).length, 1);
  assert.equal(await a.store.getDraft('see'), undefined);
  assert.equal(a.el('#view-saved').style.display, 'block');
});
test('editing has its own restorable draft and original record stays intact', async t => {
  const a = app(t);
  await a.store.put(record('r1'));
  await a.win.openForm('see', 'r1');
  a.el('[data-field="what"]').value = '修改后的光';
  await a.win.autosaveNow();
  await a.win.openForm('feel');
  await a.win.openForm('see', 'r1');
  assert.equal(a.el('[data-field="what"]').value, '修改后的光');
  assert.equal((await a.store.get('r1')).what, '光');
  await a.win.saveRecord();
  assert.equal((await a.store.get('r1')).createdAt, 1700000000000);
  assert.equal(await a.store.getDraft('__edit__r1'), undefined);
});
test('single-record linking and saving a new pair retain other relations', async t => {
  const a = app(t);
  for (const id of ['r1', 'r2', 'r3']) await a.store.put(record(id));
  await a.store.saveLinks({ 'r2|r3': { type: '很相似', note: '已有' } });
  await a.win.openLink('r1');
  assert.equal(a.win.eval('linkRecords.join()'), 'r1');
  a.win.eval("linkRelations['r1|r2'] = {type:'属于同一主题'}");
  await a.win.saveLinkRelations();
  assert.equal((await a.store.allLinks())['r2|r3'].note, '已有');
});
test('creation resumes by matching sources and does not carry content to another record', async t => {
  const a = app(t);
  await a.store.put(record('r1')); await a.store.put(record('r2'));
  await a.store.saveCreate({ id: 'c1', sourceIds: ['r1'], theme: '已保存的作品', spread: {}, chain: [], reverse: [], converge: [] });
  await a.win.openDeepen(['r1']);
  assert.equal(a.el('#deepen-theme').value, '已保存的作品');
  await a.win.openDeepen(['r2']);
  assert.equal(a.el('#deepen-theme').value, 'r2');
});
test('deletion removes dangling references and backup remains valid', async t => {
  const a = app(t);
  await a.store.put(record('r1')); await a.store.put(record('r2'));
  await a.store.saveLinks({ 'r1|r2': { type: '很相似' } });
  await a.store.saveCreate({ id: 'c1', sourceIds: ['r1', 'r2'], theme: '创作' });
  await a.store.deleteRecord('r1');
  assert.equal(Object.keys(await a.store.allLinks()).length, 0);
  const backup = { records: await a.store.all(), links: await a.store.allLinks(), creates: await a.store.allCreates() };
  assert.equal(a.win.PondCore.backup(backup).creates[0].sourceIds.join(), 'r2');
});
test('modal traps keyboard focus and restores trigger focus', async t => {
  const a = app(t);
  const trigger = a.el('.brand-nav'); trigger.focus();
  a.win.showModal('<h3>测试</h3><button id="first">第一个</button><button id="last">最后一个</button>');
  a.el('#last').focus();
  a.win.document.dispatchEvent(new a.win.KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true }));
  assert.equal(a.win.document.activeElement.id, 'first');
  a.win.closeModal();
  assert.equal(a.win.document.activeElement, trigger);
});
