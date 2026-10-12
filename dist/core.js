/* Shared validation for local records and portable backups. No network requests. */
(function (root) {
  'use strict';
  const MODES = ['see', 'feel', 'meet'];
  const FIELDS = ['title', 'what', 'feel', 'why', 'trigger', 'memory', 'sensory', 'detail', 'bridge', 'place', 'date'];
  const validId = value => typeof value === 'string' && /^[\w-]{1,100}$/.test(value);
  const plain = value => value !== null && typeof value === 'object' && !Array.isArray(value);
  function text(value, max = 20000) {
    if (value == null) return '';
    if (typeof value !== 'string' || value.length > max) throw new Error('备份中的文字字段格式或长度不正确');
    return value;
  }
  function strings(value, max = 100) {
    if (value == null) return [];
    if (!Array.isArray(value) || value.length > max) throw new Error('备份中的列表格式不正确');
    return value.map(item => text(item));
  }
  function image(value) {
    if (!value) return '';
    if (typeof value !== 'string' || value.length > 8000000 || !/^data:image\/(?:png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/.test(value)) {
      throw new Error('备份图片必须是本地 PNG、JPEG 或 WebP 图片');
    }
    return value;
  }
  function record(value) {
    if (!plain(value) || !validId(value.id) || !MODES.includes(value.mode) || !Number.isFinite(value.createdAt) || value.createdAt <= 0) {
      throw new Error('备份中的记录编号、类型或日期不正确');
    }
    const result = { id: value.id, mode: value.mode, createdAt: value.createdAt,
      updatedAt: Number.isFinite(value.updatedAt) ? value.updatedAt : value.createdAt };
    FIELDS.forEach(key => { result[key] = text(value[key]); });
    result.clues = [...new Set(strings(value.clues || value.tags, 12))];
    if (value.photos != null && (!Array.isArray(value.photos) || value.photos.length > 9)) throw new Error('每条记录最多 9 张照片');
    result.photos = (value.photos || []).map(image);
    result.board = image(value.board);
    result.boardEmpty = !result.board || value.boardEmpty === true;
    if (value.demo === true) result.demo = true;
    return result;
  }
  function ids(value) { return [...new Set((Array.isArray(value) ? value : [value]).filter(validId))]; }
  function creation(value, availableIds) {
    if (!plain(value) || !validId(value.id)) throw new Error('创作草稿格式不正确');
    const sourceIds = ids(value.sourceIds || []);
    if (sourceIds.some(id => !availableIds.has(id))) throw new Error('创作草稿引用了不存在的记录');
    const spread = {};
    for (const dim of ['形态', '氛围', '空间', '行为', '意义']) spread[dim] = strings(value.spread?.[dim]);
    const converge = value.converge || [];
    if (!Array.isArray(converge) || converge.length > 5 || converge.some(x => !Number.isInteger(x) || x < 0 || x > 5)) throw new Error('创作评分格式不正确');
    return { id: value.id, theme: text(value.theme), sourceIds, spread, chain: strings(value.chain),
      reverse: strings(value.reverse, 4), converge, finalDir: text(value.finalDir),
      status: ['酝酿中', '正在创作', '已完成'].includes(value.status) ? value.status : '酝酿中' };
  }
  function backup(value) {
    if (!plain(value) || (value.app != null && value.app !== '灵感池塘') || (value.version != null && ![1, 2].includes(value.version)) || !Array.isArray(value.records) || value.records.length > 10000) {
      throw new Error('请选择灵感池塘导出的 JSON 备份（版本 1 或 2）');
    }
    const records = value.records.map(record);
    const available = new Set(records.map(r => r.id));
    if (available.size !== records.length) throw new Error('备份中存在重复的记录编号');
    const links = {};
    if (value.links != null && !plain(value.links) && !(Array.isArray(value.links) && value.links.length === 0)) throw new Error('关联数据格式不正确');
    for (const [key, relation] of Object.entries(value.links || {})) {
      const pair = key.split('|');
      if (pair.length !== 2 || pair[0] === pair[1] || pair.some(id => !available.has(id)) || !plain(relation)) throw new Error('备份中存在无效关联');
      links[pair.sort().join('|')] = { type: text(relation.type, 100), note: text(relation.note) };
    }
    if (value.creates != null && (!Array.isArray(value.creates) || value.creates.length > 10000)) throw new Error('创作草稿列表格式不正确');
    const creates = (value.creates || []).map(c => creation(c, available));
    if (new Set(creates.map(c => c.id)).size !== creates.length) throw new Error('备份中存在重复的创作编号');
    if (value.drafts != null && (!Array.isArray(value.drafts) || value.drafts.length > 10003)) throw new Error('记录草稿列表格式不正确');
    const drafts = (value.drafts || []).map(d => {
      if (!plain(d) || typeof d.mode !== 'string' || !plain(d.data) || !(MODES.includes(d.mode) || (d.mode.startsWith('__edit__') && available.has(d.mode.slice(8))))) throw new Error('记录草稿格式不正确');
      const fields = {};
      for (const key of [...FIELDS, 'clues']) fields[key] = text(d.data.data?.[key]);
      if (d.data.photos != null && (!Array.isArray(d.data.photos) || d.data.photos.length > 9)) throw new Error('草稿照片格式不正确');
      return { mode: d.mode, data: { data: fields, photos: (d.data.photos || []).map(image), board: image(d.data.board), boardEmpty: d.data.boardEmpty === true } };
    });
    return { records, links, creates, drafts };
  }
  function draftFields(draft) { return draft?.data?.data || draft?.data || {}; }
  function search(record, query) {
    const needle = query.trim().toLocaleLowerCase('zh-CN');
    return !needle || [...FIELDS.map(key => record[key] || ''), ...(record.clues || record.tags || [])].join('\n').toLocaleLowerCase('zh-CN').includes(needle);
  }
  function sameIds(a, b) { return ids(a).sort().join('|') === ids(b).sort().join('|'); }
  const api = { record, backup, ids, draftFields, search, sameIds };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.PondCore = api;
})(globalThis);
