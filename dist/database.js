/* One database connection; writes resolve only after the transaction commits. */
const DB_NAME = 'linggan-pond';
const DB_VER = 1;
let db = null;
let dbOpening = null;
function openDB() {
  if (db) return Promise.resolve(db);
  if (dbOpening) return dbOpening;
  dbOpening = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VER);
    req.onupgradeneeded = () => {
      const database = req.result;
      if (!database.objectStoreNames.contains('records')) {
        const records = database.createObjectStore('records', { keyPath: 'id' });
        records.createIndex('mode', 'mode'); records.createIndex('createdAt', 'createdAt');
      }
      if (!database.objectStoreNames.contains('drafts')) database.createObjectStore('drafts', { keyPath: 'mode' });
    };
    req.onsuccess = () => {
      db = req.result;
      db.onversionchange = () => { db.close(); db = null; dbOpening = null; };
      resolve(db);
    };
    req.onerror = () => { dbOpening = null; reject(req.error); };
    req.onblocked = () => { if (typeof toast === 'function') toast('请关闭其他池塘标签页，再刷新以更新数据库。', true); };
  });
  return dbOpening;
}
async function tx(name, mode, fn) {
  const database = await openDB();
  return new Promise((resolve, reject) => {
    const transaction = database.transaction(name, mode);
    let request;
    transaction.oncomplete = () => resolve(request?.result);
    transaction.onerror = () => reject(transaction.error);
    transaction.onabort = () => reject(transaction.error || new Error('保存已中止，请重试'));
    try { request = fn(transaction.objectStore(name)); }
    catch (error) { transaction.abort(); reject(error); }
  });
}
const store = {
  put: rec => tx('records', 'readwrite', s => s.put(PondCore.record(rec))),
  get: id => tx('records', 'readonly', s => s.get(id)),
  all: () => tx('records', 'readonly', s => s.getAll()),
  del: id => tx('records', 'readwrite', s => s.delete(id)),
  async deleteRecord(id) {
    const database = await openDB();
    return new Promise((resolve, reject) => {
      const transaction = database.transaction(['records', 'drafts'], 'readwrite');
      const drafts = transaction.objectStore('drafts');
      transaction.oncomplete = resolve;
      transaction.onerror = () => reject(transaction.error);
      transaction.onabort = () => reject(transaction.error || new Error('删除已中止'));
      transaction.objectStore('records').delete(id);
      drafts.delete('__edit__' + id);
      const all = drafts.getAll();
      all.onsuccess = () => {
        for (const item of all.result) {
          if (item.mode === '__links__') {
            item.data = Object.fromEntries(Object.entries(item.data).filter(([key]) => !key.split('|').includes(id)));
            drafts.put(item);
          } else if (item.mode.startsWith('__create__') && item.data.sourceIds?.includes(id)) {
            item.data.sourceIds = item.data.sourceIds.filter(sourceId => sourceId !== id);
            drafts.put(item);
          }
        }
      };
    });
  },
  putDraft: (mode, data) => tx('drafts', 'readwrite', s => s.put({ mode, data })),
  getDraft: mode => tx('drafts', 'readonly', s => s.get(mode)),
  delDraft: mode => tx('drafts', 'readwrite', s => s.delete(mode)),
  saveLinks: data => tx('drafts', 'readwrite', s => s.put({ mode: '__links__', data })),
  allLinks: async () => (await tx('drafts', 'readonly', s => s.get('__links__')))?.data || {},
  saveCreate: data => tx('drafts', 'readwrite', s => s.put({ mode: '__create__' + data.id, data })),
  allCreates: async () => (await tx('drafts', 'readonly', s => s.getAll())).filter(x => x.mode.startsWith('__create__')).map(x => x.data),
  allDrafts: async () => (await tx('drafts', 'readonly', s => s.getAll())).filter(x => ['see', 'feel', 'meet'].includes(x.mode) || x.mode.startsWith('__edit__')),
  async importBackup(input) {
    const validated = PondCore.backup(input);
    const database = await openDB();
    return new Promise((resolve, reject) => {
      const transaction = database.transaction(['records', 'drafts'], 'readwrite');
      const records = transaction.objectStore('records'), drafts = transaction.objectStore('drafts');
      let added = 0, skipped = 0;
      transaction.oncomplete = () => resolve({ added, skipped });
      transaction.onerror = () => reject(transaction.error);
      transaction.onabort = () => reject(transaction.error || new Error('导入已中止，原有数据未改变'));
      // All reads and writes share this transaction, including duplicate detection.
      const existing = records.getAll();
      existing.onsuccess = () => {
        const seen = new Set(existing.result.map(r => r.id));
        for (const record of validated.records) {
          if (seen.has(record.id)) { skipped++; continue; }
          records.put(record); seen.add(record.id); added++;
        }
        const previous = drafts.get('__links__');
        previous.onsuccess = () => drafts.put({ mode: '__links__', data: { ...validated.links, ...(previous.result?.data || {}) } });
        for (const item of [...validated.drafts, ...validated.creates.map(data => ({ mode: '__create__' + data.id, data }))]) {
          const previousDraft = drafts.get(item.mode);
          previousDraft.onsuccess = () => { if (!previousDraft.result) drafts.put(item); };
        }
      };
    });
  }
};
