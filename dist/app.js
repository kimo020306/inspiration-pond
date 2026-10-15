/* ================= 图片压缩 ================= */
function compressImage(file, maxSizeKB = 500) {
  return new Promise((resolve, reject) => {
    if (!file.type.startsWith('image/')) { reject(new Error('格式不支持')); return; }
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      // 根据目标大小动态限制最大边：目标越小，先缩得越小
      let maxSide = 1600;
      if (file.size > 5 * 1024 * 1024) maxSide = 1200;
      if (file.size > 10 * 1024 * 1024) maxSide = 900;

      let { width, height } = img;
      if (width > maxSide || height > maxSide) {
        const r = Math.min(maxSide / width, maxSide / height);
        width = Math.round(width * r); height = Math.round(height * r);
      }

      function tryEncode(targetW, targetH, quality) {
        const canvas = document.createElement('canvas');
        canvas.width = targetW; canvas.height = targetH;
        const ctx = canvas.getContext('2d');
        // 统一把透明底转成白色，避免 PNG 转成 JPEG 出黑底
        ctx.fillStyle = '#fff';
        ctx.fillRect(0, 0, targetW, targetH);
        ctx.drawImage(img, 0, 0, targetW, targetH);
        return new Promise((res, rej) => {
          canvas.toBlob((blob) => {
            if (!blob) { rej(new Error('压缩失败（canvas 无法导出）')); return; }
            if (blob.size / 1024 <= maxSizeKB) {
              const reader = new FileReader();
              reader.onload = () => res(reader.result);
              reader.onerror = () => rej(reader.error);
              reader.readAsDataURL(blob);
            } else {
              res({ tooBig: true, blob });
            }
          }, 'image/jpeg', quality);
        });
      }

      async function compressLoop() {
        let w = width, h = height;
        let quality = 0.82;
        // 先尝试高质量
        let r = await tryEncode(w, h, quality);
        if (typeof r === 'string') return r;
        // 降低质量
        for (quality of [0.72, 0.62, 0.52, 0.42]) {
          r = await tryEncode(w, h, quality);
          if (typeof r === 'string') return r;
        }
        // 仍太大则降分辨率
        const sizes = [1200, 900, 700, 500];
        for (const s of sizes) {
          const r2 = Math.min(s / width, s / height, 1);
          w = Math.round(width * r2); h = Math.round(height * r2);
          r = await tryEncode(w, h, 0.72);
          if (typeof r === 'string') return r;
          r = await tryEncode(w, h, 0.52);
          if (typeof r === 'string') return r;
        }
        // 兜底：直接返回最后一次 blob（理论上不会到这里）
        return new Promise((res, rej) => {
          const reader = new FileReader();
          reader.onload = () => res(reader.result);
          reader.onerror = () => rej(reader.error);
          reader.readAsDataURL(r.blob);
        });
      }

      URL.revokeObjectURL(url);
      compressLoop().then(resolve, reject);
    };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('图片加载失败')); };
    img.src = url;
  });
}

/* ================= 状态 ================= */
let currentMode = 'see';
let editingId = null;   // 编辑中的记录 id，null 为新建
let photos = [];        // dataURL 数组
let boardRef = null;    // 白板控制器
let formSession = 0;
let formLoading = false;
let savingRecord = false;
let savedFormState = '';
let formDirty = false;
function formState() {
  return JSON.stringify({ data: collectData(), photos, board: boardRef && !boardRef.isEmpty() ? boardRef.getData() : '' });
}
function draftKey() { return editingId ? '__edit__' + editingId : currentMode; }

const MODES = {
  see: {
    title: '始于看见',
    desc: '先把眼前吸引你的东西留下来。',
    autoTitle: '看见',
  },
  feel: {
    title: '始于感受',
    desc: '不必马上解释清楚，先留下这种感受。',
    autoTitle: '感受',
  },
  meet: {
    title: '我都想记录',
    desc: '看见的、感受到的，都留在这里。',
    autoTitle: '一起记录',
  }
};

/* ================= 表单渲染 ================= */
function renderFormBody(mode) {
  const el = document.getElementById('form-body');
  el.innerHTML = '';

  // 照片区（看见/相遇有；感受是"添加触发照片"）
  const showPhotoPrimary = mode === 'see' || mode === 'meet';
  const photoLabel = mode === 'feel' ? '添加触发照片' : '添加照片';

  const photoWrap = document.createElement('div');
  photoWrap.className = 'field-gap';
  photoWrap.innerHTML = `
    <label class="field">${photoLabel}${mode === 'see' ? ' · 主要视觉' : ''}</label>
    <div class="photo-grid">
      <div id="photo-items"></div>
      <div class="photo-add" id="photo-add" tabindex="0" role="button">
        <span>＋</span><span>${mode === 'feel' ? '添加照片' : '添加照片'}</span>
        <input type="file" accept="image/*" multiple id="photo-input">
      </div>
    </div>
    ${mode === 'feel' ? '<p class="placeholder-hint">照片用于记录触发情绪的事物，不是视觉主体。</p>' : ''}
  `;
  el.appendChild(photoWrap);

  // 文字输入
  const textFields = [];
  if (mode === 'see' || mode === 'meet') {
    textFields.push({ key: 'what', label: '我看到了什么？', ph: '墙上的光斑像一片正在移动的叶子。', big: false });
  }
  if (mode === 'feel' || mode === 'meet') {
    textFields.push({ key: 'feel', label: mode === 'feel' ? '我现在感受到了什么？' : '我感受到了什么？', ph: '', big: mode === 'feel' });
  }
  textFields.forEach(tf => {
    const d = document.createElement('div');
    d.className = 'field-gap';
    d.innerHTML = `<label class="field">${tf.label}</label>
      <textarea class="${tf.big ? 'big' : ''}" data-field="${tf.key}" placeholder="${tf.ph}"></textarea>`;
    el.appendChild(d);
  });
  // 次级操作：画一下 / 继续补充
  const sub = document.createElement('div');
  sub.className = 'collapse';
  sub.id = 'collapse-draw';
  sub.innerHTML = `
    <button type="button" class="collapse-head" data-target="draw" aria-expanded="false"><span class="arrow" aria-hidden="true">▸</span> 画一下</button>
    <div class="collapse-body">
      <p class="placeholder-hint" style="margin-top:0">${mode === 'feel' ? '不用画具体物体，用线条、颜色和力度留下感受。' : (mode === 'see' ? '留下轮廓、构图，或者一个值得记住的细节。' : '画下现场，也可以让现场与感受叠在一起。')}</p>
      <div class="board">
        <canvas id="board-canvas" aria-label="速写画布，用手指、鼠标或触控笔绘画"></canvas>
        <div class="board-tools" id="board-tools"></div>
      </div>
    </div>`;
  el.appendChild(sub);

  const sub2 = document.createElement('div');
  sub2.className = 'collapse';
  sub2.id = 'collapse-extra';
  sub2.innerHTML = `
    <button type="button" class="collapse-head" data-target="extra" aria-expanded="false"><span class="arrow" aria-hidden="true">▸</span> 继续补充</button>
    <div class="collapse-body" id="extra-body"></div>`;
  el.appendChild(sub2);
  renderExtraFields(mode);

  // 绑定
  document.getElementById('photo-add').addEventListener('click', e => { if (e.target.id !== 'photo-input') document.getElementById('photo-input').click(); });
  document.getElementById('photo-add').addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); document.getElementById('photo-input').click(); } });
  document.getElementById('photo-input').addEventListener('change', onPhotoSelect);
  document.querySelectorAll('.collapse-head').forEach(h => {
    h.addEventListener('click', () => {
      const target = h.dataset.target;
      const c = target === 'draw' ? sub : sub2;
      c.classList.toggle('open');
      h.setAttribute('aria-expanded', String(c.classList.contains('open')));
      if (target === 'draw' && c.classList.contains('open')) {
        if (!boardRef) initBoard();
        else boardRef.resize();
      }
    });
  });

  renderPhotoItems();
}

function renderExtraFields(mode) {
  const el = document.getElementById('extra-body');
  const fields = [];
  const common = (mode) => [
    { key: 'title', label: '自定义标题', type: 'text', ph: '留空则自动生成' },
    { key: 'date', label: '补录日期（选填）', type: 'date' },
  ];
  if (mode === 'see') {
    fields.push(...[
      { key: 'title', label: '自定义标题', type: 'text', ph: '留空则自动生成' },
      { key: 'why', label: '哪里漂亮、有趣或有新意？', type: 'textarea' },
      { key: 'place', label: '地点', type: 'text' },
      { key: 'date', label: '补录日期（选填）', type: 'date' },
      { key: 'clues', label: '视觉线索（颜色、形态、材质、构图）', type: 'text', ph: '用空格或逗号分隔' },
    ]);
  } else if (mode === 'feel') {
    fields.push(...[
      { key: 'title', label: '自定义标题', type: 'text', ph: '留空则自动生成' },
      { key: 'trigger', label: '是什么激起了这种情绪？', type: 'textarea' },
      { key: 'memory', label: '它让我想起了什么？', type: 'textarea' },
      { key: 'sensory', label: '如果它是一种颜色、形状、声音或材质？', type: 'text' },
      { key: 'date', label: '补录日期（选填）', type: 'date' },
      { key: 'clues', label: '感受线索', type: 'text', ph: '用空格或逗号分隔' },
    ]);
  } else {
    fields.push(...[
      { key: 'title', label: '自定义标题', type: 'text', ph: '留空则自动生成' },
      { key: 'detail', label: '哪个细节让我停下来？', type: 'textarea' },
      { key: 'bridge', label: '看见与感受之间发生了什么？', type: 'textarea' },
      { key: 'place', label: '地点', type: 'text' },
      { key: 'date', label: '补录日期（选填）', type: 'date' },
      { key: 'clues', label: '看见与感受的线索', type: 'text', ph: '用空格或逗号分隔' },
    ]);
  }
  fields.forEach(f => {
    const d = document.createElement('div');
    d.className = 'field-gap';
    if (f.type === 'textarea') {
      d.innerHTML = `<label class="field">${f.label}</label><textarea data-field="${f.key}"></textarea>`;
    } else {
      d.innerHTML = `<label class="field">${f.label}</label><input type="${f.type}" data-field="${f.key}" placeholder="${f.ph || ''}">`;
    }
    el.appendChild(d);
  });
}

/* ================= 照片 ================= */
function renderPhotoItems() {
  const c = document.getElementById('photo-items');
  if (!c) return;
  c.innerHTML = '';
  photos.forEach((p, i) => {
    const d = document.createElement('div');
    d.className = 'photo-item';
    d.innerHTML = `<img src="${esc(p)}" alt="灵感照片" loading="lazy" width="160" height="160"><button class="del" data-i="${i}" aria-label="移除第 ${i + 1} 张照片">×</button>`;
    d.querySelector('.del').addEventListener('click', (e) => {
      e.stopPropagation();
      photos.splice(i, 1);
      renderPhotoItems();
      autosave();
    });
    c.appendChild(d);
  });
}

async function onPhotoSelect(e) {
  const session = formSession;
  const files = Array.from(e.target.files || []);
  e.target.value = '';
  if (!files.length) return;
  for (const f of files) {
    if (photos.length >= 9) { toast('最多 9 张照片', true); break; }
    try {
      const data = await compressImage(f);
      if (session !== formSession) return;
      photos.push(data);
    } catch (err) {
      toast('图片处理失败：' + err.message, true);
    }
  }
  renderPhotoItems();
  autosave();
}

/* ================= 白板 ================= */
function initBoard() {
  boardRef = PondDrawing.mount(document.getElementById('board-canvas'), document.getElementById('board-tools'), autosave, message => toast(message, true));
}

/* ================= 校验与保存 ================= */
function collectData() {
  const data = {};
  document.querySelectorAll('[data-field]').forEach(el => { data[el.dataset.field] = el.value.trim(); });
  return data;
}

function hasContent() {
  const d = collectData();
  const hasText = (d.what || d.feel || '').length > 0;
  const hasPhoto = photos.length > 0;
  let hasDraw = false;
  if (boardRef) hasDraw = !boardRef.isEmpty();
  return { hasText, hasPhoto, hasDraw, d };
}

function autoTitle(mode, data) {
  if (data.title) return data.title;
  const text = (data.what || data.feel || '').trim();
  if (text) return text.slice(0, 16);
  const date = new Date().toLocaleDateString('zh-CN', { month: 'long', day: 'numeric' });
  return `${MODES[mode].autoTitle}·${date}`;
}

function parseTags(str) {
  if (!str) return [];
  return str.split(/[\s,，、]+/).filter(Boolean).slice(0, 12);
}

async function saveRecord() {
  if (savingRecord || formLoading) return;
  const { hasText, hasPhoto, hasDraw, d } = hasContent();
  if (!hasText && !hasPhoto && !hasDraw) {
    toast('还空着呢：写一句、加张图，或画一笔再保存。', true);
    return;
  }
  savingRecord = true;
  clearTimeout(autosaveTimer);
  const saveButton = document.getElementById('btn-save');
  if (saveButton) { saveButton.disabled = true; saveButton.textContent = '正在保存…'; }
  const now = Date.now();
  const rec = {
    id: editingId || ('r' + now + Math.random().toString(36).slice(2, 7)),
    mode: currentMode,
    title: autoTitle(currentMode, d),
    what: d.what || '',
    feel: d.feel || '',
    why: d.why || '',
    trigger: d.trigger || '',
    memory: d.memory || '',
    sensory: d.sensory || '',
    detail: d.detail || '',
    bridge: d.bridge || '',
    place: d.place || '',
    date: d.date || '',
    clues: parseTags(d.clues),
    photos: [...photos],
    board: boardRef ? boardRef.getData() : '',
    boardEmpty: boardRef ? boardRef.isEmpty() : true,
    createdAt: editingId ? undefined : now,
    updatedAt: now,
  };
  try {
  if (editingId) {
    // 保留原创建时间
    const old = await store.get(editingId);
    rec.createdAt = old ? old.createdAt : now;
  }
    await store.put(rec);
    // A draft cleanup failure must never report a successfully stored record as failed.
    await store.delDraft(draftKey()).catch(error => console.warn('草稿清理失败', error));
    savedFormState = formState();
    formDirty = false;
    toast('已经替你留下来了。');
    // 提供查看/继续
    showSavedActions(rec.id);
  } catch (e) {
    console.error('保存失败详情:', e);
    let msg = '保存失败：' + (e.name || 'Error') + ' ' + (e.message || '');
    if ((e.name || '').includes('QuotaExceeded') || /quota|full/i.test(e.message || '')) {
      msg = '存储空间已满：建议减少照片数量，或到“我的池塘”删除旧记录后再试。';
    }
    if ((e.message || '').includes('DataCloneError')) {
      msg = '数据格式异常，可能是图片损坏，请移除照片后重试。';
    }
    toast(msg, true);
  } finally {
    savingRecord = false;
    if (saveButton) { saveButton.disabled = false; saveButton.textContent = '放进池塘'; }
  }
}

function showSavedActions(id) {
  // 保存成功：跳到独立的"已经替你留下来了"页
  show('saved');
  const viewBtn = document.getElementById('saved-view');
  const contBtn = document.getElementById('saved-continue');
  const pondLink = document.getElementById('saved-pond');
  viewBtn.onclick = () => showDetail(id);
  contBtn.onclick = () => { resetForm(); renderSaveBar(); openForm(currentMode); };
  pondLink.onclick = (e) => { e.preventDefault(); openPond(); };
}

function renderSaveBar() {
  const bar = document.querySelector('.save-bar');
  bar.innerHTML = `<button class="btn btn-primary" id="btn-save" aria-label="保存到灵感池塘">放进池塘</button>`;
  const btn = document.getElementById('btn-save');
  btn.addEventListener('click', saveRecord);
}

function resetForm() {
  clearTimeout(autosaveTimer);
  formSession++;
  boardRef?.destroy();
  formDirty = false;
  photos = [];
  boardRef = null;
  editingId = null;
  document.querySelectorAll('[data-field]').forEach(el => el.value = '');
  renderPhotoItems();
  const draw = document.getElementById('collapse-draw');
  const extra = document.getElementById('collapse-extra');
  if (draw) draw.classList.remove('open');
  if (extra) extra.classList.remove('open');
  // 清空画布区，重新 init
  const tools = document.getElementById('board-tools');
  if (tools) tools.innerHTML = '';
  const canvas = document.getElementById('board-canvas');
  if (canvas) { canvas.width = 300; canvas.height = 300; }
}

/* ================= 草稿 ================= */
let autosaveTimer = null;
function autosave() {
  if (formLoading || savingRecord) return;
  formDirty = true;
  clearTimeout(autosaveTimer);
  const session = formSession;
  autosaveTimer = setTimeout(async () => {
    if (session === formSession) await autosaveNow();
  }, 600);
}
// 文字输入触发草稿
document.addEventListener('input', (e) => { if (e.target.closest('#form-body')) autosave(); });

/* ================= 草稿保护 ================= */
/* 表单有内容（未保存）时，离开前弹窗让用户选择 */
function formHasDirtyContent() {
  return formDirty;
}

async function guardLeaveForm(continueFn) {
  if (document.getElementById('view-form').style.display === 'none') { continueFn(); return; }
  if (!formHasDirtyContent()) { continueFn(); return; }
  // 有内容：弹窗选择
  showModal(`
    <h3>这段还没放进池塘</h3>
    <p style="color:var(--sub);font-size:13px;margin-bottom:16px">你现在写下的内容还没有正式保存。</p>
    <button class="opt" id="leave-keep" style="font-weight:600">保留草稿并离开</button>
    <button class="opt" id="leave-discard" style="color:var(--coral)">放弃这次修改</button>
    <button class="opt" id="leave-stay" style="background:var(--deep);color:#fff">继续编辑</button>
  `);
  document.getElementById('leave-keep').addEventListener('click', async () => {
    if (!await autosaveNow()) return;
    closeModal();
    continueFn();
  });
  document.getElementById('leave-discard').addEventListener('click', async () => {
    clearTimeout(autosaveTimer);
    await store.delDraft(draftKey());
    closeModal();
    continueFn();
  });
  document.getElementById('leave-stay').addEventListener('click', closeModal);
}

/* 立即保存当前草稿（不 debounce） */
async function autosaveNow() {
  clearTimeout(autosaveTimer);
  try {
    const { hasText, hasPhoto, hasDraw, d } = hasContent();
    const key = draftKey();
    if (!Object.values(d).some(Boolean) && !hasPhoto && !hasDraw) { await store.delDraft(key); return true; }
    const draft = { data: d, photos: [...photos], board: hasDraw ? boardRef.getData() : '', boardEmpty: !hasDraw };
    await store.putDraft(key, draft);
    return true;
  } catch (e) {
    console.warn('草稿保存失败:', e);
    toast('草稿未保存，请保持页面打开，尝试减少照片后再次保存。', true);
    return false;
  }
}

/* ================= 导航 ================= */
function show(view) {
  ['home', 'form', 'pond', 'detail', 'link', 'saved'].forEach(v => {
    document.getElementById('view-' + v).style.display = 'none';
  });
  document.getElementById('view-' + view).style.display = 'block';
  window.scrollTo(0, 0);
}

async function openForm(mode, id) {
  resetForm();
  const session = formSession;
  currentMode = mode;
  editingId = id || null;
  document.getElementById('form-title').textContent = MODES[mode].title;
  document.getElementById('form-desc').textContent = MODES[mode].desc;
  show('form');
  renderFormBody(mode);
  renderSaveBar();

  // 表单返回链接：有未保存内容时弹窗守卫
  const back = document.getElementById('form-back');
  if (back) {
    back.onclick = (e) => {
      e.preventDefault();
      guardLeaveForm(() => { resetForm(); show('home'); });
    };
  }

  formLoading = true;
  document.getElementById('btn-save').disabled = true;
  try {
  if (id) {
    // 编辑态：载入记录
    await loadForEdit(id, session);
    if (session === formSession) await loadDraft(draftKey(), session);
  } else {
    // 新建：载入草稿
    await loadDraft(mode, session);
  }
  if (session === formSession) { savedFormState = formState(); formDirty = false; }
  } catch (error) { toast('无法载入记录，请刷新重试。', true); }
  finally { if (session === formSession) { formLoading = false; document.getElementById('btn-save').disabled = false; } }
}

async function loadDraft(mode, session = formSession) {
  const rec = await store.getDraft(mode);
  if (!rec || session !== formSession) return;
  const d = PondCore.draftFields(rec);
  document.querySelectorAll('#form-body [data-field]').forEach(el => {
    if (typeof d[el.dataset.field] === 'string') el.value = d[el.dataset.field];
  });
  photos = rec.data.photos || rec.photos || [];
  renderPhotoItems();
  if (boardRef) { boardRef.destroy(); boardRef = null; }
  if (rec.data.board && rec.data.boardEmpty !== true) {
    document.getElementById('collapse-draw').classList.add('open');
    document.querySelector('[data-target="draw"]').setAttribute('aria-expanded', 'true');
    if (!boardRef) initBoard();
    boardRef.restore(rec.data.board);
  }
}

async function loadForEdit(id, session = formSession) {
  const rec = await store.get(id);
  if (!rec || session !== formSession) return;
  photos = rec.photos || [];
  renderPhotoItems();
  const map = { what: rec.what, feel: rec.feel, why: rec.why, trigger: rec.trigger, memory: rec.memory, sensory: rec.sensory, detail: rec.detail, bridge: rec.bridge, place: rec.place, date: rec.date, title: rec.title };
  Object.keys(map).forEach(k => {
    const el = document.querySelector(`[data-field="${k}"]`);
    if (el && map[k]) el.value = map[k];
  });
  const tagsEl = document.querySelector('[data-field="clues"]');
  if (tagsEl) tagsEl.value = getClues(rec).join(' ');
  // 白板恢复
  if (rec.board && !rec.boardEmpty) {
    document.getElementById('collapse-draw').classList.add('open');
    document.querySelector('[data-target="draw"]').setAttribute('aria-expanded', 'true');
    if (!boardRef) initBoard();
    boardRef.restore(rec.board);
  }
}

/* ================= 详情 ================= */
function showDetail(id) {
  renderDetail(id);
}

async function renderDetail(id) {
  const rec = await store.get(id);
  if (!rec) { toast('记录不存在'); return; }
  const el = document.getElementById('view-detail');
  const modeLabel = { see: '始于看见', feel: '始于感受', meet: '我都想记录' }[rec.mode];
  const modeCls = { see: 'mode-see', feel: 'mode-feel', meet: 'mode-meet' }[rec.mode];

  let photosHtml = '';
  if (rec.photos && rec.photos.length) {
    photosHtml = '<div class="detail-photos">' + rec.photos.map(p => `<img src="${p}" alt="灵感照片" loading="lazy">`).join('') + '</div>';
  }
  let boardHtml = '';
  if (rec.board && !rec.boardEmpty) {
    boardHtml = `<div class="detail-board"><img src="${rec.board}" alt="灵感速写"></div>`;
  }
  let tagsHtml = '';
  if (getClues(rec).length) {
    tagsHtml = '<div class="detail-tags">' + getClues(rec).map(t => `<span class="rel-tag">${esc(t)}</span>`).join('') + '</div>';
  }

  // 文本区
  let textHtml = '';
  const txtParts = [];
  if (rec.what) txtParts.push({ label: '我看到了', val: rec.what });
  if (rec.feel) txtParts.push({ label: '我感受到了', val: rec.feel });
  if (rec.why) txtParts.push({ label: '哪里特别', val: rec.why });
  if (rec.trigger) txtParts.push({ label: '激起的情绪', val: rec.trigger });
  if (rec.memory) txtParts.push({ label: '想起', val: rec.memory });
  if (rec.sensory) txtParts.push({ label: '通感', val: rec.sensory });
  if (rec.detail) txtParts.push({ label: '停下的细节', val: rec.detail });
  if (rec.bridge) txtParts.push({ label: '看见与感受之间', val: rec.bridge });
  if (rec.place) txtParts.push({ label: '地点', val: rec.place });
  txtParts.forEach(p => { textHtml += `<div class="detail-section"><h3>${p.label}</h3><div class="detail-text">${esc(p.val)}</div></div>`; });

  const dateStr = new Date(rec.createdAt).toLocaleString('zh-CN', { year: 'numeric', month: 'long', day: 'numeric', hour: '2-digit', minute: '2-digit' });

  el.innerHTML = `
    <div class="detail-wrap">
      <a class="back" href="#" data-back="pond">← 返回池塘</a>
      <div class="detail-card glass">
        <div class="detail-title">${esc(rec.title)}</div>
        <div class="detail-meta">
          <span class="mode-badge ${modeCls}">${modeLabel}</span>
          <span>${dateStr}${rec.date ? ' · 补录 ' + esc(rec.date) : ''}</span>
        </div>
        ${photosHtml}
        ${boardHtml}
        ${textHtml}
        ${tagsHtml}
        <div class="detail-section"><h3>这些碎片，可能有关。</h3><div id="link-suggest"></div></div>
        <div class="detail-actions">
          <button class="btn btn-primary" data-act="link">串联记录</button>
          <button class="btn btn-ghost" data-act="edit">编辑</button>
          <button class="btn btn-ghost" data-act="del" style="color:var(--coral)">删除</button>
        </div>
      </div>
    </div>`;
  show('detail');

  // 关联推荐
  renderLinkSuggest(rec);

  el.querySelector('[data-act="link"]').addEventListener('click', () => openLink(id));
  el.querySelector('[data-act="edit"]').addEventListener('click', () => openForm(rec.mode, id));
  el.querySelector('[data-act="del"]').addEventListener('click', () => deleteRecord(id));
  el.querySelector('[data-back="pond"]').addEventListener('click', (e) => { e.preventDefault(); openPond(); });
}

function esc(s) {
  return String(s || '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

/* 统一读取线索：兼容旧字段 tags，优先新字段 clues */
function getClues(rec) {
  return rec.clues || rec.tags || [];
}

async function deleteRecord(id) {
  // 先检查是否有关联，用于提示
  const links = await store.allLinks().catch(() => ({}));
  const relatedKeys = Object.keys(links).filter(k => k.split('|').includes(id));
  const warn = relatedKeys.length
    ? `确定删除这条记录吗？删除后不可恢复。\n\n它有 ${relatedKeys.length} 条关联，对应关系会一并移除。`
    : '确定删除这条记录吗？删除后不可恢复。';
  if (!confirm(warn)) return;
  await store.deleteRecord(id);
  toast('已删除');
  openPond();
}

/* ================= 关联推荐 ================= */
async function renderLinkSuggest(rec) {
  const box = document.getElementById('link-suggest');
  if (!box) return;
  const all = await store.all();
  const others = all.filter(r => r.id !== rec.id);
  const keywords = new Set();
  getClues(rec).forEach(t => keywords.add(t));
  // 提取文字关键词（2字以上）
  const text = (rec.what || '') + ' ' + (rec.feel || '') + ' ' + (rec.why || '') + ' ' + (rec.title || '');
  const tokens = text.match(/[\u4e00-\u9fa5]{2,}/g) || [];
  tokens.forEach(t => { if (t.length >= 2 && t.length <= 6) keywords.add(t); });

  const matches = [];
  others.forEach(o => {
    const common = [];
    keywords.forEach(k => {
      const oText = (o.title || '') + ' ' + (o.what || '') + ' ' + (o.feel || '') + ' ' + getClues(o).join(' ');
      if (oText.includes(k)) common.push(k);
    });
    if (common.length) matches.push({ rec: o, common });
  });
  matches.sort((a, b) => b.common.length - a.common.length);
  const top = matches.slice(0, 5);

  if (!top.length) {
    box.innerHTML = '<p style="color:var(--sub);font-size:13px">暂时没有明显相关的碎片，你可以手动选择记录来串联。</p>';
    return;
  }
  box.innerHTML = top.map((m, i) => {
    const kws = m.common.map(k => `<span class="link-kw">${esc(k)}</span>`).join('');
    const reason = `它们都提到「${m.common[0]}」${m.common.length > 1 ? '等共同线索' : ''}。`;
    return `<div class="link-item">
      <strong>${esc(m.rec.title)}</strong>
      <div class="link-reason">${kws}</div>
      <div class="link-reason">${reason}</div>
      <button class="btn btn-sec" data-link-to="${m.rec.id}">串在一起</button>
    </div>`;
  }).join('');
  box.querySelectorAll('[data-link-to]').forEach(b => {
    b.addEventListener('click', () => {
      const from = rec.id;
      const to = b.dataset.linkTo;
      openLink([from, to]);
    });
  });
}

function toast(msg, warm) {
  const t = document.getElementById('toast');
  t.textContent = msg;
  t.classList.toggle('warm', !!warm);
  t.classList.add('show');
  clearTimeout(t._t);
  t._t = setTimeout(() => t.classList.remove('show'), 2200);
}

/* ================= 池塘列表 ================= */
let pondFilter = 'all';       // all / see / feel / meet
let pondTag = '';             // 标签筛选
let pondSearch = '';
let pondSort = 'new';         // new / old
let selectedIds = new Set();  // 多选
let pondView = 'list';        // list / pond

async function openPond() {
  const el = document.getElementById('view-pond');
  el.innerHTML = `
    <div class="pond-head">
      <h2 class="pond-title">我的池塘</h2>
      <div class="btn-row" style="margin:0">
        <button class="btn btn-ghost" id="pond-new">＋ 新建记录</button>
        <button class="btn btn-primary" id="pond-link">串联灵感</button>
        <button class="btn btn-ghost" id="pond-backup">备份</button>
      </div>
    </div>
    <div class="pond-toolbar">
      <div class="pond-view-toggle">
        <button class="filter-chip ${pondView === 'list' ? 'active' : ''}" id="pond-view-list">列表视图</button>
        <button class="filter-chip ${pondView === 'pond' ? 'active' : ''}" id="pond-view-pond">池塘视图</button>
      </div>
      <button class="btn btn-sec" id="pond-random" style="padding:7px 14px;font-size:13px">捞一捞</button>
      <button class="btn btn-sec" id="pond-sort" style="padding:7px 14px;font-size:13px">${pondSort === 'new' ? '最新优先' : '最早优先'}</button>
    </div>
    <div id="pond-body"></div>
  `;
  show('pond');

  el.querySelector('#pond-view-list').addEventListener('click', () => { pondView = 'list'; openPond(); });
  el.querySelector('#pond-view-pond').addEventListener('click', () => { pondView = 'pond'; openPond(); });
  el.querySelector('#pond-random').addEventListener('click', randomRecord);
  el.querySelector('#pond-sort').addEventListener('click', () => { pondSort = pondSort === 'new' ? 'old' : 'new'; openPond(); });
  el.querySelector('#pond-new').addEventListener('click', () => { show('home'); });
  el.querySelector('#pond-link').addEventListener('click', () => openLink([]));
  el.querySelector('#pond-backup').addEventListener('click', showBackupModal);

  if (pondView === 'pond') {
    await renderPondScene();
  } else {
    await renderPondListView();
  }
}

/* 列表视图主体（含筛选、搜索、卡片） */
async function renderPondListView() {
  const body = document.getElementById('pond-body');
  body.innerHTML = `
    <div class="pond-toolbar">
      <button class="filter-chip ${pondFilter === 'all' ? 'active' : ''}" data-f="all">全部</button>
      <button class="filter-chip ${pondFilter === 'see' ? 'active' : ''}" data-f="see">始于看见</button>
      <button class="filter-chip ${pondFilter === 'feel' ? 'active' : ''}" data-f="feel">始于感受</button>
      <button class="filter-chip ${pondFilter === 'meet' ? 'active' : ''}" data-f="meet">我都想记录</button>
    </div>
    <div class="pond-toolbar">
      <input type="text" class="search-input" id="pond-search" placeholder="搜索标题或正文…" value="${esc(pondSearch)}" style="border:1px solid rgba(78,156,173,.3);border-radius:12px;padding:10px 14px;background:#fff;font-size:14px">
    </div>
    <div id="pond-tags"></div>
    <div id="pond-cards" class="cards"></div>
  `;

  body.querySelectorAll('[data-f]').forEach(c => {
    c.addEventListener('click', () => { pondFilter = c.dataset.f; openPond(); });
  });
  const si = body.querySelector('#pond-search');
  let searchTimer = null;
  si.addEventListener('input', (e) => {
    pondSearch = e.target.value;
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => renderPondCards(), 180);
  });

  await renderPondTags();
  await renderPondCards();
}

async function renderPondTags() {
  const box = document.getElementById('pond-tags');
  const all = await store.all();
  const tagCount = {};
  all.forEach(r => getClues(r).forEach(t => { tagCount[t] = (tagCount[t] || 0) + 1; }));
  const tags = Object.keys(tagCount).sort((a, b) => tagCount[b] - tagCount[a]).slice(0, 20);
  if (!tags.length) { box.innerHTML = ''; return; }
  box.innerHTML = '<div class="pond-toolbar" style="margin-bottom:12px">' +
    `<button class="filter-chip ${pondTag === '' ? 'active' : ''}" data-t="">全部标签</button>` +
    tags.map(t => `<button class="filter-chip ${pondTag === t ? 'active' : ''}" data-t="${esc(t)}">${esc(t)} (${tagCount[t]})</button>`).join('') +
    '</div>';
  box.querySelectorAll('[data-t]').forEach(c => {
    c.addEventListener('click', () => { pondTag = c.dataset.t; renderPondTags(); renderPondCards(); });
  });
}

async function renderPondCards() {
  const box = document.getElementById('pond-cards');
  if (!box) return;
  let all = await store.all();
  if (pondFilter !== 'all') all = all.filter(r => r.mode === pondFilter);
  if (pondTag) all = all.filter(r => getClues(r).includes(pondTag));
  if (pondSearch) {
    const q = pondSearch.toLowerCase();
    all = all.filter(r => PondCore.search(r, q));
  }
  all.sort((a, b) => pondSort === 'new' ? b.createdAt - a.createdAt : a.createdAt - b.createdAt);

  if (!all.length) {
    box.innerHTML = `<div class="empty-state"><div class="big">🫧</div>${pondSearch || pondTag || pondFilter !== 'all' ? '没有找到匹配的灵感，试试其他关键词或筛选。' : '池塘还很安静，留下第一条灵感吧。'}</div>`;
    return;
  }

  box.innerHTML = all.map(r => {
    const modeLabel = { see: '始于看见', feel: '始于感受', meet: '我都想记录' }[r.mode];
    const modeCls = { see: 'mode-see', feel: 'mode-feel', meet: 'mode-meet' }[r.mode];
    const thumb = (r.photos && r.photos.length) ? `<img src="${r.photos[0]}" alt="灵感照片" loading="lazy">`
      : (r.board && !r.boardEmpty ? `<img src="${r.board}" alt="灵感速写" loading="lazy">` : `<div class="noimg">${esc((r.what || r.feel || r.title).slice(0, 40)) || '（无文字）'}</div>`);
    const tags = getClues(r).slice(0, 3).map(t => `<span>${esc(t)}</span>`).join('');
    const sel = selectedIds.has(r.id) ? 'style="outline:3px solid var(--koi)"' : '';
    const demo = r.demo ? '<span class="demo-badge">演示</span>' : '';
    return `<div class="rec-card glass" data-id="${r.id}" role="button" tabindex="0" aria-label="打开记录：${esc(r.title)}" ${sel}>
      <div class="rec-thumb">${thumb}</div>
      <div class="rec-body">
        <div class="rec-title">${esc(r.title)} ${demo}</div>
        <div class="rec-meta"><span class="mode-badge ${modeCls}">${modeLabel}</span><span>${new Date(r.createdAt).toLocaleDateString('zh-CN')}</span></div>
        <div class="rec-tags">${tags}</div>
      </div>
    </div>`;
  }).join('');

  box.querySelectorAll('.rec-card').forEach(card => {
    card.addEventListener('click', () => showDetail(card.dataset.id));
    card.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); showDetail(card.dataset.id); } });
  });
}

/* ================= 池塘生态视图 ================= */
/* 元素映射：根据记录状态映射为池塘元素 */
function elementFor(rec, all, links) {
  const linkCount = Object.keys(links).filter(k => k.split('|').includes(rec.id)).length;
  const created = rec.createdAt || 0;
  const ageDays = (Date.now() - created) / 86400000;
  if (linkCount >= 1) return 'weed';            // 有关联 → 水草（持续生长）
  if (ageDays > 30) return 'stone';              // 稳定老记录 → 鹅卵石
  if (ageDays < 1) return 'leaf';                // 新加入 → 漂浮叶片
  return 'kopi';                                  // 其余 → 金鱼
}

/* 各元素 SVG 图标（池塘生态视觉） */
function elementSvg(kind) {
  switch (kind) {
    case 'kopi':
      return '<svg viewBox="0 0 48 48" width="46" height="46" aria-hidden="true"><ellipse cx="24" cy="26" rx="17" ry="11" fill="#F47A4D"/><path d="M24 26l-7-7" stroke="#E5523A" stroke-width="3" stroke-linecap="round"/><circle cx="16" cy="24" r="1.6" fill="#173B47"/><circle cx="32" cy="24" r="1.6" fill="#173B47"/><path d="M40 20c-4 0-4 4 0 4" fill="none" stroke="#E5523A" stroke-width="3" stroke-linecap="round"/></svg>';
    case 'stone':
      return '<svg viewBox="0 0 48 48" width="42" height="42" aria-hidden="true"><ellipse cx="24" cy="28" rx="16" ry="11" fill="#B7CDD3"/><ellipse cx="24" cy="27" rx="12" ry="7" fill="#C9DCE1"/></svg>';
    case 'weed':
      return '<svg viewBox="0 0 48 48" width="44" height="44" aria-hidden="true"><path d="M24 42c0-10-4-18-10-24" stroke="#4E9CAD" stroke-width="4" stroke-linecap="round" fill="none"/><path d="M24 42c0-9 5-16 11-21" stroke="#357F91" stroke-width="4" stroke-linecap="round" fill="none"/><path d="M24 42c0-8 1-13 3-19" stroke="#6FB0BE" stroke-width="4" stroke-linecap="round" fill="none"/></svg>';
    case 'leaf':
      return '<svg viewBox="0 0 48 48" width="40" height="40" aria-hidden="true"><path d="M24 8c12 2 18 10 18 18 0-14-6-20-18-18z" fill="#F5B942"/><path d="M24 8c-12 2-18 10-18 18 0-14 6-20 18-18z" fill="#FFD98E"/><path d="M24 8v30" stroke="#E5A22F" stroke-width="2.5"/></svg>';
  }
}

async function renderPondScene() {
  const body = document.getElementById('pond-body');
  const all = await store.all();
  if (!all.length) {
    body.innerHTML = `<div class="empty-state"><div class="big">🫧</div>池塘还很安静，留下第一条灵感吧。</div>`;
    return;
  }
  const links = await store.allLinks().catch(() => ({}));

  // 2D 布局：把元素散布在水面，避免重叠（简单网格抖动）
  const visible = all.slice(0, 120);
  const count = visible.length;
  const cols = window.matchMedia('(max-width: 720px)').matches ? 3 : 6;
  const rows = Math.ceil(count / cols);
  const sceneHeight = Math.max(420, rows * 110 + 90);
  const positions = [];
  visible.forEach((rec, i) => {
    const col = i % cols, row = Math.floor(i / cols);
    const baseX = 7 + col * (84 / cols);
    const baseY = 30 + row * 110;
    positions.push({
      rec,
      kind: elementFor(rec, all, links),
      x: baseX + ((i * 37) % 3),
      y: baseY + ((i * 13) % 8),
    });
  });

  body.innerHTML = `
    ${elementLegend()}
    <div class="pond-scene" id="pond-scene" style="min-height:${sceneHeight}px">
      <div class="waterline"></div>
      ${positions.map(p => `
        <div class="pond-element ${p.kind}" data-id="${p.rec.id}" role="button" tabindex="0" aria-label="打开记录：${esc(p.rec.title)}" style="left:${p.x}%;top:${p.y}px">
          ${elementSvg(p.kind)}
          <span class="pe-label">${esc(p.rec.title)}</span>
        </div>`).join('')}
      <div class="scene-hint">${all.length > 120 ? '展示前 120 条灵感，可在列表中查找全部记录' : '点击水面上的元素，重新遇见一条灵感'}</div>
    </div>
  `;

  body.querySelectorAll('.pond-element').forEach(el => {
    el.addEventListener('click', () => showDetail(el.dataset.id));
    el.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); showDetail(el.dataset.id); } });
  });
}

/* 元素图例说明 */
function elementLegend() {
  return `
    <div style="display:flex;gap:14px;flex-wrap:wrap;margin-bottom:14px;font-size:12px;color:var(--sub)">
      <span>${elementSvg('leaf')} 漂浮叶片 · 新灵感</span>
      <span>${elementSvg('stone')} 鹅卵石 · 稳定记录</span>
      <span>${elementSvg('weed')} 水草 · 有关联</span>
      <span>${elementSvg('kopi')} 金鱼 · 常在流动</span>
    </div>`;
}

async function randomRecord() {
  const all = await store.all();
  if (!all.length) { toast('池塘还是空的'); return; }
  const links = await store.allLinks().catch(() => ({}));
  const r = all[Math.floor(Math.random() * all.length)];
  const kind = elementFor(r, all, links);
  const kindName = { kopi: '金鱼', stone: '鹅卵石', weed: '水草', leaf: '漂浮叶片' }[kind];
  const modeLabel = { see: '始于看见', feel: '始于感受', meet: '我都想记录' }[r.mode];

  // 捞一捞动画浮层
  const overlay = document.createElement('div');
  overlay.className = 'scoop-overlay';
  overlay.id = 'scoop-overlay';
  overlay.innerHTML = `
    <div class="scoop-panel" role="dialog" aria-modal="true">
      <div class="scoop-anim net">🥅</div>
      <h2>今天从池塘里捞到了它</h2>
      <div style="margin:10px 0">${elementSvg(kind)}</div>
      <div class="scoop-title">${esc(r.title)}</div>
      <div class="scoop-meta">${kindName} · ${modeLabel} · ${new Date(r.createdAt).toLocaleDateString('zh-CN')}</div>
      <div class="scoop-actions">
        <button class="btn btn-primary" id="scoop-view">看看它</button>
        <button class="btn btn-ghost" id="scoop-again">再捞一次</button>
        <button class="btn btn-ghost" id="scoop-relate">它和什么有关</button>
      </div>
    </div>`;
  document.body.appendChild(overlay);

  overlay.querySelector('#scoop-view').addEventListener('click', () => { overlay.remove(); showDetail(r.id); });
  overlay.querySelector('#scoop-again').addEventListener('click', () => { overlay.remove(); randomRecord(); });
  overlay.querySelector('#scoop-relate').addEventListener('click', () => { overlay.remove(); openLink([r.id]); });
  overlay.addEventListener('click', (e) => { if (e.target === overlay) overlay.remove(); });
}

/* ================= 备份 ================= */
function showBackupModal() {
  showModal(`
    <h3>备份与导入</h3>
    <p style="color:var(--sub);font-size:13px">记录保存在此设备的浏览器中，清理浏览器数据可能导致丢失，请定期备份。</p>
    <button class="opt" id="bk-export">导出备份（JSON）</button>
    <button class="opt" id="bk-import">导入备份</button>
    <button class="opt" id="bk-close">关闭</button>
  `);
  document.getElementById('bk-export').addEventListener('click', exportBackup);
  document.getElementById('bk-import').addEventListener('click', () => document.getElementById('backup-input').click());
  document.getElementById('bk-close').addEventListener('click', closeModal);
}

async function exportBackup() {
  const all = await store.all();
  const links = await store.allLinks ? await store.allLinks() : [];
  const creates = await store.allCreates ? await store.allCreates() : [];
  const drafts = await store.allDrafts();
  const data = { app: '灵感池塘', version: 2, exportedAt: new Date().toISOString(), records: all, links, creates, drafts };
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = '灵感池塘备份-' + new Date().toISOString().slice(0, 10) + '.json';
  a.click();
  URL.revokeObjectURL(url);
  toast('备份已导出');
  closeModal();
}

async function importBackup(file) {
  try {
    if (file.size > 64 * 1024 * 1024) throw new Error('备份超过 64 MB，请拆分后导入');
    const text = await file.text();
    const data = JSON.parse(text);
    const { added, skipped } = await store.importBackup(data);
    toast(`导入完成：新增 ${added} 条，跳过重复 ${skipped} 条`);
    closeModal();
    openPond();
  } catch (e) {
    toast('导入失败：' + e.message, true);
  }
}

/* ================= 串联 ================= */
let linkRecords = [];  // 待串联的记录 id 列表
let linkRelations = {}; // { pairKey: {type, note} }
let linkSaveQueue = Promise.resolve();

async function openLink(ids) {
  await linkSaveQueue.catch(() => {});
  linkRecords = PondCore.ids(ids);
  linkRelations = await store.allLinks();
  if (linkRecords.length === 1) {
    const source = linkRecords[0];
    const partners = Object.keys(linkRelations).filter(key => key.split('|').includes(source)).flatMap(key => key.split('|'));
    linkRecords = PondCore.ids([...linkRecords, ...partners]);
  }
  const existing = new Set((await store.all()).map(rec => rec.id));
  linkRecords = linkRecords.filter(id => existing.has(id));
  await renderLink();
  show('link');
  if (linkRecords.length < 2) await showAddMoreModal();
}

async function renderLink() {
  const el = document.getElementById('view-link');
  const recs = [];
  for (const id of linkRecords) { const r = await store.get(id); if (r) recs.push(r); }
  const list = recs.map(r => {
    const thumb = (r.photos && r.photos.length) ? `<img src="${r.photos[0]}" style="width:60px;height:60px;object-fit:cover;border-radius:8px">` : '';
    return `<div class="link-item" style="display:flex;gap:12px;align-items:center">${thumb}<div><strong>${esc(r.title)}</strong><div style="color:var(--sub);font-size:12px">${['始于看见','始于感受','我都想记录'][r.mode === 'see' ? 0 : r.mode === 'feel' ? 1 : 2]}</div></div></div>`;
  }).join('');

  el.innerHTML = `
    <div class="detail-wrap">
      <a class="back" href="#" data-back="pond">← 返回</a>
      <div class="detail-card glass">
        <h2 style="margin:0 0 6px">灵感串联</h2>
        <p style="color:var(--sub);font-size:13px">看见、感受和一起记录的灵感，都可以串联。为每对碎片选择一种关系。</p>
        ${list}
        <div id="link-relations" style="margin-top:16px"></div>
        <div class="detail-actions" style="margin-top:16px">
          <button class="btn btn-ghost" id="link-add-more">添加更多记录</button>
          <button class="btn btn-primary" id="link-done">保存并回到池塘</button>
        </div>
        <p id="link-save-status" role="status" aria-live="polite" style="font-size:12px;color:var(--sub)"></p>
      </div>
    </div>`;
  el.querySelector('[data-back="pond"]').addEventListener('click', (e) => { e.preventDefault(); openPond(); });
  el.querySelector('#link-add-more').addEventListener('click', showAddMoreModal);
  el.querySelector('#link-done').addEventListener('click', async () => {
    try { await saveLinkRelations(); toast('串联关系已保存'); await openPond(); }
    catch (error) { toast('保存失败，请重试：' + error.message, true); }
  });

  renderLinkRelations(recs);
}

function renderLinkRelations(recs) {
  const box = document.getElementById('link-relations');
  if (!box) return;
  const relTypes = ['很相似', '彼此相反', '一个触发另一个', '属于同一主题', '暂时说不清，但感觉有关'];
  // 列出所有两两组合
  const pairs = [];
  for (let i = 0; i < recs.length; i++) {
    for (let j = i + 1; j < recs.length; j++) {
      pairs.push([recs[i], recs[j]]);
    }
  }
  if (!pairs.length) { box.innerHTML = '<p style="color:var(--sub)">至少需要 2 条记录才能建立关联。</p>'; return; }

  box.innerHTML = '<h3 style="font-size:14px;color:var(--deep)">关系设置</h3>' + pairs.map(([a, b]) => {
    const key = [a.id, b.id].sort().join('|');
    const rel = linkRelations[key] || {};
    return `<div class="link-item">
      <div style="font-size:13px;color:var(--sub)">${esc(a.title)} ↔ ${esc(b.title)} · ${linkRelations[key] ? '已串联' : '未设置关系'}</div>
      <div style="margin-top:8px;display:flex;flex-wrap:wrap;gap:6px">
        ${relTypes.map(t => `<button class="filter-chip ${rel.type === t ? 'active' : ''}" data-pair="${key}" data-type="${t}">${t}</button>`).join('')}
      </div>
      <div style="margin-top:8px;display:flex;gap:8px;align-items:center">
        <input type="text" placeholder="补充关系说明（选填）" style="flex:1;border:1px solid rgba(78,156,173,.3);border-radius:10px;padding:8px 12px;font-size:13px" data-note="${key}" value="${esc(rel.note || '')}">
        <button class="btn btn-ghost" data-remove="${key}" style="padding:8px 12px;font-size:12px">解除</button>
      </div>
    </div>`;
  }).join('');

  box.querySelectorAll('[data-type]').forEach(b => {
    b.addEventListener('click', () => {
      const key = b.dataset.pair;
      if (!linkRelations[key]) linkRelations[key] = {};
      linkRelations[key].type = b.dataset.type;
      saveLinkRelations().catch(() => {});
      renderLinkRelations(recs);
    });
  });
  box.querySelectorAll('[data-note]').forEach(i => {
    i.addEventListener('input', (e) => {
      const key = e.target.dataset.note;
      if (!linkRelations[key]) linkRelations[key] = { type: '暂时说不清，但感觉有关' };
      linkRelations[key].note = e.target.value;
      saveLinkRelations().catch(() => {});
    });
  });
  box.querySelectorAll('[data-remove]').forEach(b => {
    b.addEventListener('click', () => {
      delete linkRelations[b.dataset.remove];
      saveLinkRelations().catch(() => {});
      renderLinkRelations(recs);
    });
  });
}

async function saveLinkRelations() {
  const snapshot = JSON.parse(JSON.stringify(linkRelations));
  const status = document.getElementById('link-save-status');
  if (status) status.textContent = '正在保存…';
  linkSaveQueue = linkSaveQueue.catch(() => {}).then(() => store.saveLinks(snapshot));
  try { await linkSaveQueue; if (status) status.textContent = '串联关系已保存'; }
  catch (error) { if (status) status.textContent = '保存失败，请点击“保存并回到池塘”重试'; throw error; }
}

async function showAddMoreModal() {
  const all = await store.all();
  const selected = new Set(linkRecords);
  const labels = { see: '始于看见', feel: '始于感受', meet: '我都想记录' };
  const html = `<h3>选择要串联的灵感</h3><p class="link-picker-hint">三种记录都在这里，可跨类型选择至少 2 条。</p>` +
    (all.length ? all.map(r => `<label class="link-picker-row"><input type="checkbox" data-link-select="${r.id}" ${selected.has(r.id) ? 'checked' : ''}><span><strong>${esc(r.title)}</strong><small>${labels[r.mode]}</small></span></label>`).join('') : '<p>先留下两条灵感，就可以把它们串在一起。</p>') +
    `<p id="link-picker-count" role="status"></p><div class="btn-row"><button class="btn btn-ghost" id="link-picker-cancel">取消</button><button class="btn btn-primary" id="link-picker-done">开始串联</button></div>`;
  showModal(html);
  function update() {
    document.getElementById('link-picker-count').textContent = `已选 ${selected.size} 条`;
    document.getElementById('link-picker-done').disabled = selected.size < 2;
  }
  document.querySelectorAll('[data-link-select]').forEach(input => {
    input.addEventListener('change', () => { if (input.checked) selected.add(input.dataset.linkSelect); else selected.delete(input.dataset.linkSelect); update(); });
  });
  document.getElementById('link-picker-cancel').addEventListener('click', closeModal);
  document.getElementById('link-picker-done').addEventListener('click', async () => {
    if (selected.size < 2) return;
    linkRecords = [...selected];
    for (let i = 0; i < linkRecords.length; i++) {
      for (let j = i + 1; j < linkRecords.length; j++) {
        const key = [linkRecords[i], linkRecords[j]].sort().join('|');
        if (!linkRelations[key]) linkRelations[key] = { type: '暂时说不清，但感觉有关' };
      }
    }
    closeModal();
    try { await saveLinkRelations(); await renderLink(); toast('灵感已串联，可以继续补充关系'); }
    catch (error) { await renderLink(); toast('关系尚未保存，请重试：' + error.message, true); }
  });
  update();
}

function downloadURL(url, name) {
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
}

/* ================= Modal 工具 ================= */
let _modalEscHandler = null;
let _modalPreviousFocus = null;
function showModal(html) {
  closeModal();
  _modalPreviousFocus = document.activeElement;
  const mask = document.createElement('div');
  mask.className = 'modal-mask';
  mask.id = 'modal-mask';
  mask.setAttribute('role', 'dialog');
  mask.setAttribute('aria-modal', 'true');
  mask.setAttribute('aria-label', '灵感池塘操作');
  mask.innerHTML = `<div class="modal">${html}</div>`;
  mask.addEventListener('click', (e) => { if (e.target === mask) closeModal(); });
  document.body.appendChild(mask);
  // ESC 关闭
  _modalEscHandler = (e) => {
    if (e.key === 'Escape') { closeModal(); return; }
    if (e.key !== 'Tab') return;
    const focusable = [...mask.querySelectorAll('button:not(:disabled), a[href], input, textarea, [tabindex="0"]')];
    const first = focusable[0], last = focusable[focusable.length - 1];
    if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last?.focus(); }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first?.focus(); }
  };
  document.addEventListener('keydown', _modalEscHandler);
  // 焦点落到第一个按钮
  setTimeout(() => {
    const first = mask.querySelector('button, [tabindex], a');
    if (first) first.focus({ preventScroll: true });
  }, 0);
}
function closeModal() {
  const m = document.getElementById('modal-mask');
  if (m) m.remove();
  if (_modalEscHandler) { document.removeEventListener('keydown', _modalEscHandler); _modalEscHandler = null; }
  if (_modalPreviousFocus?.isConnected) _modalPreviousFocus.focus();
  _modalPreviousFocus = null;
}

/* ================= 初始化 ================= */
document.querySelectorAll('.entry').forEach(el => {
  el.addEventListener('click', () => openForm(el.dataset.mode));
  el.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openForm(el.dataset.mode); } });
});
document.querySelectorAll('[data-back]:not(#form-back)').forEach(el => {
  el.addEventListener('click', (e) => { e.preventDefault(); guardLeaveForm(() => { show('home'); }); });
});
document.querySelector('.brand-nav').addEventListener('click', (e) => {
  e.preventDefault();
  guardLeaveForm(() => { openPond(); });
});

document.getElementById('backup-input').addEventListener('change', (e) => {
  const f = e.target.files[0];
  if (f) importBackup(f);
  e.target.value = '';
});

// 起点卡导出改为本地 Canvas 自绘，不依赖第三方 CDN，离线也能用
openDB().then(() => {
  console.log('灵感池塘已就绪');
}).catch(err => {
  console.error('数据库初始化失败', err);
  toast('无法打开本地存储。请允许此网站保存数据，或换用普通浏览器窗口。', true);
});

// Associate visible labels with both static and dynamically rendered controls.
function labelControls() {
  document.querySelectorAll('input:not([type="file"]), textarea').forEach((control, index) => {
    if (!control.id) control.id = 'pond-field-' + index;
    control.name = control.name || control.dataset.field || control.id;
    control.autocomplete = 'off';
    const label = control.closest('.field-gap')?.querySelector('label.field');
    if (label) label.htmlFor = control.id;
    else if (!control.hasAttribute('aria-label')) control.setAttribute('aria-label', control.placeholder || '输入内容');
  });
}
const labelObserver = new MutationObserver(labelControls);
labelObserver.observe(document.getElementById('app'), { childList: true, subtree: true });
labelControls();
window.addEventListener('beforeunload', event => {
  if (document.getElementById('view-form').style.display !== 'none' && formDirty) { event.preventDefault(); event.returnValue = ''; }
});
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden' && !formLoading && formDirty && document.getElementById('view-form').style.display !== 'none') autosaveNow();
});
window.addEventListener('unhandledrejection', event => {
  console.error('操作失败', event.reason);
  toast('操作未完成，请保持页面打开并重试；建议先导出备份。', true);
});
/* PWA：注册 Service Worker，用于离线缓存与独立窗口安装 */
if ('serviceWorker' in navigator && location.protocol !== 'file:') {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('sw.js').catch(err => {
      console.warn('Service Worker 注册失败（离线能力不可用，不影响使用）:', err);
    });
  });
}
