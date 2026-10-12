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
    title: '始于相遇',
    desc: '留下你看见的，也留下它在你心里引起的变化。',
    autoTitle: '相遇',
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

  // 文字输入（带语音输入）
  const textFields = [];
  if (mode === 'see' || mode === 'meet') {
    textFields.push({ key: 'what', label: '我看到了什么？', ph: '墙上的光斑像一片正在移动的叶子。', big: false, voiceHint: '说说你眼前看到了什么。' });
  }
  if (mode === 'feel' || mode === 'meet') {
    textFields.push({ key: 'feel', label: mode === 'feel' ? '我现在感受到了什么？' : '我感受到了什么？', ph: '', big: mode === 'feel', voiceHint: mode === 'feel' ? '想到什么就说什么，不必整理。' : '说说你看到了什么，以及它让你想到了什么。' });
  }
  textFields.forEach(tf => {
    const d = document.createElement('div');
    d.className = 'field-gap';
    d.innerHTML = `<label class="field">${tf.label}</label>
      <div class="voice-input">
        <textarea class="${tf.big ? 'big' : ''}" data-field="${tf.key}" placeholder="${tf.ph}"></textarea>
        <button type="button" class="voice-btn" data-voice="${tf.key}" data-voice-hint="${tf.voiceHint}" aria-label="语音输入">🎙️</button>
      </div>`;
    el.appendChild(d);
  });
  // 语音输入按钮绑定
  el.querySelectorAll('.voice-btn').forEach(btn => {
    btn.addEventListener('click', () => startVoice(btn.dataset.voice, btn.dataset.voiceHint));
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
        <canvas id="board-canvas"></canvas>
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
      if (target === 'draw' && c.classList.contains('open') && !boardRef) {
        initBoard();
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
      { key: 'clues', label: '相遇线索', type: 'text', ph: '用空格或逗号分隔' },
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
  const canvas = document.getElementById('board-canvas');
  const tools = document.getElementById('board-tools');
  const ctx = canvas.getContext('2d');

  // 高分辨率适配
  function resize() {
    const rect = canvas.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    const w = rect.width, h = rect.height;
    // 保留已有内容
    const old = document.createElement('canvas');
    old.width = canvas.width; old.height = canvas.height;
    old.getContext('2d').drawImage(canvas, 0, 0);
    canvas.width = w * dpr; canvas.height = h * dpr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, w, h);
    ctx.drawImage(old, 0, 0, w, h);
    ctx.lineCap = 'round'; ctx.lineJoin = 'round';
  }
  resize();
  window.addEventListener('resize', resize);

  const state = {
    color: '#173B47',
    size: 3,
    eraser: false,
    drawing: false,
    undo: [],
    redo: [],
    hasStrokes: false
  };

  // 工具栏
  const colors = ['#173B47', '#357F91', '#4E9CAD', '#F47A4D', '#E5523A', '#F5B942'];
  let toolsHtml = colors.map(c => `<button class="color ${c === state.color ? 'active' : ''}" data-color="${c}" style="background:${c}"></button>`).join('');
  toolsHtml += `<span class="spacer"></span>
    <button class="tool" data-act="pen">画笔</button>
    <button class="tool" data-act="eraser">橡皮</button>
    <input type="range" min="1" max="16" value="3" id="size-range">
    <button class="tool" data-act="undo">撤销</button>
    <button class="tool" data-act="redo">重做</button>
    <button class="tool" data-act="clear">清空</button>`;
  tools.innerHTML = toolsHtml;

  function pushUndo() {
    state.undo.push(canvas.toDataURL());
    if (state.undo.length > 30) state.undo.shift();
    state.redo = [];
  }

  function restore(data) {
    const img = new Image();
    img.onload = () => { ctx.clearRect(0, 0, canvas.width, canvas.height); ctx.drawImage(img, 0, 0); };
    img.src = data;
  }

  function getPos(e) {
    const rect = canvas.getBoundingClientRect();
    if (e.touches) {
      return { x: e.touches[0].clientX - rect.left, y: e.touches[0].clientY - rect.top };
    }
    return { x: e.clientX - rect.left, y: e.clientY - rect.top };
  }

  function start(e) {
    e.preventDefault();
    state.drawing = true;
    if (!state.eraser) state.hasStrokes = true;
    pushUndo();
    const p = getPos(e);
    ctx.beginPath();
    ctx.moveTo(p.x, p.y);
    ctx.strokeStyle = state.eraser ? '#ffffff' : state.color;
    ctx.lineWidth = state.eraser ? state.size * 3 : state.size;
  }
  function move(e) {
    if (!state.drawing) return;
    e.preventDefault();
    const p = getPos(e);
    ctx.lineTo(p.x, p.y);
    ctx.stroke();
  }
  function end() {
    if (state.drawing) { state.drawing = false; autosave(); }
  }

  canvas.addEventListener('mousedown', start);
  canvas.addEventListener('mousemove', move);
  canvas.addEventListener('mouseup', end);
  canvas.addEventListener('mouseleave', end);
  canvas.addEventListener('touchstart', start, { passive: false });
  canvas.addEventListener('touchmove', move, { passive: false });
  canvas.addEventListener('touchend', end);

  tools.addEventListener('click', (e) => {
    const colorBtn = e.target.closest('.color');
    const toolBtn = e.target.closest('.tool');
    if (colorBtn) {
      state.color = colorBtn.dataset.color;
      state.eraser = false;
      tools.querySelectorAll('.color').forEach(c => c.classList.toggle('active', c === colorBtn));
      tools.querySelectorAll('.tool').forEach(t => t.classList.remove('active'));
      return;
    }
    if (toolBtn) {
      const act = toolBtn.dataset.act;
      if (act === 'pen') { state.eraser = false; tools.querySelectorAll('.tool').forEach(t => t.classList.toggle('active', t.dataset.act === 'pen')); }
      if (act === 'eraser') { state.eraser = true; tools.querySelectorAll('.tool').forEach(t => t.classList.toggle('active', t.dataset.act === 'eraser')); }
      if (act === 'undo') { const d = state.undo.pop(); if (d) { state.redo.push(canvas.toDataURL()); restore(d); autosave(); } }
      if (act === 'redo') { const d = state.redo.pop(); if (d) { state.undo.push(canvas.toDataURL()); restore(d); autosave(); } }
      if (act === 'clear') {
        if (confirm('确定清空白板吗？可先撤销恢复。')) {
          pushUndo();
          state.hasStrokes = false;
          ctx.fillStyle = '#fff';
          ctx.fillRect(0, 0, canvas.width, canvas.height);
          autosave();
        }
      }
    }
  });
  tools.querySelector('#size-range').addEventListener('input', (e) => { state.size = parseInt(e.target.value, 10); });

  boardRef = {
    canvas, ctx,
    getData: () => {
      // 限制输出分辨率并转 JPEG，减少 IndexedDB 压力
      const max = 1200;
      const w = canvas.width, h = canvas.height;
      let nw = w, nh = h;
      if (w > max || h > max) {
        const r = Math.min(max / w, max / h);
        nw = Math.round(w * r); nh = Math.round(h * r);
      }
      const c = document.createElement('canvas');
      c.width = nw; c.height = nh;
      c.getContext('2d').drawImage(canvas, 0, 0, nw, nh);
      return c.toDataURL('image/jpeg', 0.88);
    },
    isEmpty: () => !state.hasStrokes,
    destroy: () => { window.removeEventListener('resize', resize); },
    restore: (data) => {
      if (data) {
        state.hasStrokes = true;
        const img = new Image();
        img.onload = () => { ctx.drawImage(img, 0, 0, canvas.width / (window.devicePixelRatio || 1), canvas.height / (window.devicePixelRatio || 1)); };
        img.src = data;
      }
    }
  };
}

/* ================= 语音输入（Web Speech API） ================= */
let voiceRec = null;         // SpeechRecognition 实例
let voiceTargetField = null; // 目标 textarea 的 data-field key
let voiceFinal = '';         // 已确认的最终文字
let voiceLiveText = '';      // 正在识别中的临时文字
let voiceOverlayEl = null;   // 浮层 DOM

function startVoice(fieldKey, hint) {
  if (!('webkitSpeechRecognition' in window) && !('SpeechRecognition' in window)) {
    toast('当前浏览器不支持语音识别，请改用键盘输入。', true);
    return;
  }
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  // 若已有实例则先停止
  if (voiceRec) { try { voiceRec.stop(); } catch (e) {} voiceRec = null; }

  voiceTargetField = fieldKey;
  voiceFinal = '';
  voiceLiveText = '';
  const rec = new SR();
  rec.lang = 'zh-CN';
  rec.continuous = true;   // 长语音：连续识别
  rec.interimResults = true; // 实时中间结果
  rec.maxAlternatives = 1;

  rec.onresult = (e) => {
    let interim = '';
    for (let i = e.resultIndex; i < e.results.length; i++) {
      const r = e.results[i];
      if (r.isFinal) { voiceFinal += r[0].transcript; }
      else { interim += r[0].transcript; }
    }
    voiceLiveText = voiceFinal + interim;
    updateVoiceOverlay();
  };
  rec.onerror = (e) => {
    const errMap = {
      'not-allowed': '麦克风权限被拒绝。你仍然可以直接打字记录。',
      'no-speech': '没有听到声音，请再试一次。',
      'audio-capture': '没有找到可用的麦克风。',
      'network': '网络异常，语音识别失败。',
      'service-not-allowed': '语音服务不可用，请改用键盘输入。',
      'aborted': ''
    };
    const msg = errMap[e.error] || ('语音识别出错：' + e.error);
    voiceRec = null;
    updateVoiceOverlay(msg);
    // 若已有最终文字，保留，不中断
    if (e.error === 'aborted') { return; }
  };
  rec.onend = () => {
    voiceRec = null;
    updateVoiceOverlay();
  };

  voiceRec = rec;
  showVoiceOverlay(hint);
  try { rec.start(); } catch (e) { toast('无法启动语音识别', true); closeVoiceOverlay(); }
}

function showVoiceOverlay(hint) {
  closeVoiceOverlay();
  const overlay = document.createElement('div');
  overlay.className = 'voice-overlay';
  overlay.id = 'voice-overlay';
  overlay.innerHTML = `
    <div class="voice-panel" role="dialog" aria-modal="true" aria-label="正在听">
      <div class="v-icon">🎙️</div>
      <div class="v-title">正在听……</div>
      <div class="v-hint">${esc(hint || '直接说就好，不用组织完整。')}</div>
      <div class="v-live empty" id="voice-live">（还没听到内容…）</div>
      <div class="v-err" id="voice-err"></div>
      <div class="v-actions">
        <button class="btn btn-ghost" id="voice-pause" aria-label="暂停">暂停</button>
        <button class="btn btn-primary" id="voice-done" aria-label="完成并填入">完成</button>
        <button class="btn btn-ghost" id="voice-cancel" aria-label="取消">取消</button>
      </div>
    </div>`;
  document.body.appendChild(overlay);
  voiceOverlayEl = overlay;

  const pauseBtn = overlay.querySelector('#voice-pause');
  const doneBtn = overlay.querySelector('#voice-done');
  const cancelBtn = overlay.querySelector('#voice-cancel');
  // 点击蒙层不关闭，防止误触
  pauseBtn.addEventListener('click', togglePause);
  doneBtn.addEventListener('click', commitVoice);
  cancelBtn.addEventListener('click', cancelVoice);
}

function togglePause() {
  if (!voiceRec) return;
  const btn = document.getElementById('voice-pause');
  if (btn.dataset.paused === '1') {
    voiceRec.start();
    btn.dataset.paused = '0';
    btn.textContent = '暂停';
  } else {
    voiceRec.stop();
    btn.dataset.paused = '1';
    btn.textContent = '继续';
  }
}

function updateVoiceOverlay(errMsg) {
  if (!voiceOverlayEl) return;
  const live = voiceOverlayEl.querySelector('#voice-live');
  const err = voiceOverlayEl.querySelector('#voice-err');
  if (live) {
    const txt = voiceLiveText || voiceFinal;
    live.textContent = txt || '（还没听到内容…）';
    live.classList.toggle('empty', !txt);
  }
  if (err) err.textContent = errMsg || '';
}

function commitVoice() {
  const finalText = (voiceFinal + voiceLiveText).trim();
  if (voiceRec) { try { voiceRec.stop(); } catch (e) {} voiceRec = null; }
  closeVoiceOverlay();
  if (finalText) {
    const el = document.querySelector(`[data-field="${voiceTargetField}"]`);
    if (el) {
      // 追加到已有文字末尾（分隔）
      const existing = el.value.trim();
      el.value = existing ? existing + '\n' + finalText : finalText;
      autosave();
    }
    toast('已把说的话转成文字，可继续编辑。');
  } else {
    toast('没有识别到内容。', true);
  }
}

function cancelVoice() {
  if (voiceRec) { try { voiceRec.abort(); } catch (e) {} voiceRec = null; }
  closeVoiceOverlay();
}

function closeVoiceOverlay() {
  if (voiceOverlayEl) { voiceOverlayEl.remove(); voiceOverlayEl = null; }
  voiceLiveText = '';
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
  ['home', 'form', 'pond', 'detail', 'link', 'deepen', 'saved'].forEach(v => {
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
  const modeLabel = { see: '始于看见', feel: '始于感受', meet: '始于相遇' }[rec.mode];
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
          <button class="btn btn-ghost" data-act="deepen">开始创作</button>
          <button class="btn btn-ghost" data-act="edit">编辑</button>
          <button class="btn btn-ghost" data-act="del" style="color:var(--coral)">删除</button>
        </div>
      </div>
    </div>`;
  show('detail');

  // 关联推荐
  renderLinkSuggest(rec);

  el.querySelector('[data-act="link"]').addEventListener('click', () => openLink(id));
  el.querySelector('[data-act="deepen"]').addEventListener('click', () => openDeepen([id]));
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
  if (deepenDraft?.sourceIds?.includes(id)) deepenDraft = null;
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
      <button class="filter-chip ${pondFilter === 'meet' ? 'active' : ''}" data-f="meet">始于相遇</button>
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
    const modeLabel = { see: '始于看见', feel: '始于感受', meet: '始于相遇' }[r.mode];
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
  const modeLabel = { see: '始于看见', feel: '始于感受', meet: '始于相遇' }[r.mode];

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
        <button class="btn btn-ghost" id="scoop-deepen">从它继续想</button>
      </div>
    </div>`;
  document.body.appendChild(overlay);

  overlay.querySelector('#scoop-view').addEventListener('click', () => { overlay.remove(); showDetail(r.id); });
  overlay.querySelector('#scoop-again').addEventListener('click', () => { overlay.remove(); randomRecord(); });
  overlay.querySelector('#scoop-relate').addEventListener('click', () => { overlay.remove(); openLink([r.id]); });
  overlay.querySelector('#scoop-deepen').addEventListener('click', () => { overlay.remove(); openDeepen([r.id]); });
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

async function openLink(ids) {
  linkRecords = PondCore.ids(ids);
  linkRelations = await store.allLinks();
  const el = document.getElementById('view-link');
  await renderLink();
  show('link');
}

async function renderLink() {
  const el = document.getElementById('view-link');
  const recs = [];
  for (const id of linkRecords) { const r = await store.get(id); if (r) recs.push(r); }
  const modeLabel = { see: '始于看见', feel: '始于感受', meet: '始于相遇' }[0] || '';
  const list = recs.map(r => {
    const thumb = (r.photos && r.photos.length) ? `<img src="${r.photos[0]}" style="width:60px;height:60px;object-fit:cover;border-radius:8px">` : '';
    return `<div class="link-item" style="display:flex;gap:12px;align-items:center">${thumb}<div><strong>${esc(r.title)}</strong><div style="color:var(--sub);font-size:12px">${['始于看见','始于感受','始于相遇'][r.mode === 'see' ? 0 : r.mode === 'feel' ? 1 : 2]}</div></div></div>`;
  }).join('');

  el.innerHTML = `
    <div class="detail-wrap">
      <a class="back" href="#" data-back="pond">← 返回</a>
      <div class="detail-card glass">
        <h2 style="margin:0 0 6px">灵感串联</h2>
        <p style="color:var(--sub);font-size:13px">选择这些碎片之间的关系。</p>
        ${list}
        <div id="link-relations" style="margin-top:16px"></div>
        <div class="detail-actions" style="margin-top:16px">
          <button class="btn btn-ghost" id="link-add-more">添加更多记录</button>
          <button class="btn btn-primary" id="link-goto-deepen">去创作深化 →</button>
        </div>
      </div>
    </div>`;
  el.querySelector('[data-back="pond"]').addEventListener('click', (e) => { e.preventDefault(); openPond(); });
  el.querySelector('#link-add-more').addEventListener('click', showAddMoreModal);
  el.querySelector('#link-goto-deepen').addEventListener('click', () => openDeepen(linkRecords));

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
      <div style="font-size:13px;color:var(--sub)">${esc(a.title)} ↔ ${esc(b.title)}</div>
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
      saveLinkRelations();
      renderLinkRelations(recs);
    });
  });
  box.querySelectorAll('[data-note]').forEach(i => {
    i.addEventListener('input', (e) => {
      const key = e.target.dataset.note;
      if (!linkRelations[key]) linkRelations[key] = {};
      linkRelations[key].note = e.target.value;
      saveLinkRelations();
    });
  });
  box.querySelectorAll('[data-remove]').forEach(b => {
    b.addEventListener('click', () => {
      delete linkRelations[b.dataset.remove];
      saveLinkRelations();
      renderLinkRelations(recs);
    });
  });
}

async function saveLinkRelations() {
  // 保存到 IndexedDB links store（简化：存为 records 的特殊类型）
  await store.saveLinks(linkRelations);
}

async function showAddMoreModal() {
  const all = await store.all();
  const others = all.filter(r => !linkRecords.includes(r.id));
  const html = `<h3>添加记录到串联</h3>` + others.map(r => `<button class="opt" data-add="${r.id}">${esc(r.title)}</button>`).join('') + `<button class="opt" id="am-done" style="background:var(--deep);color:#fff">完成</button>`;
  showModal(html);
  document.querySelectorAll('[data-add]').forEach(b => {
    b.addEventListener('click', () => {
      linkRecords.push(b.dataset.add);
      linkRecords = Array.from(new Set(linkRecords));
      closeModal();
      renderLink();
    });
  });
  document.getElementById('am-done').addEventListener('click', closeModal);
}

/* ================= 深化 ================= */
let deepenIds = [];
let deepenDraft = null;  // { id, spread, chain, reverse, converge, done }

async function openDeepen(ids) {
  deepenIds = PondCore.ids(ids);
  const recs = [];
  for (const id of deepenIds) { const r = await store.get(id); if (r) recs.push(r); }
  const baseTheme = recs.map(r => r.title).join(' · ').slice(0, 60) || '我的创作';
  if (!deepenDraft || !PondCore.sameIds(deepenDraft.sourceIds, deepenIds)) {
    const saved = await store.allCreates();
    deepenDraft = saved.find(draft => PondCore.sameIds(draft.sourceIds, deepenIds)) || { id: 'c' + Date.now(), theme: baseTheme, spread: {}, chain: [], reverse: [], converge: [], finalDir: '', status: '酝酿中', sourceIds: deepenIds };
  }
  deepenDraft.sourceIds = deepenIds;
  renderDeepen();
  show('deepen');
}

function renderDeepen() {
  const d = deepenDraft;
  const el = document.getElementById('view-deepen');

  // 扩散法
  const dims = ['形态', '氛围', '空间', '行为', '意义'];
  const spreadHtml = dims.map(dim => {
    const items = d.spread[dim] || [];
    return `<div class="dim-row">
      <div class="dim-label">${dim}</div>
      <div class="dim-items">
        ${items.map((it, i) => `<span class="chip">${esc(it)} <a href="#" data-del-spread="${dim}|${i}" style="color:var(--coral);text-decoration:none">×</a></span>`).join('')}
        <input type="text" placeholder="添加联想…" data-add-spread="${dim}" style="border:none;border-bottom:1px dashed rgba(78,156,173,.4);background:transparent;padding:4px;font-size:13px;width:120px">
      </div>
    </div>`;
  }).join('');

  // 接龙法
  const chainHtml = (d.chain || []).map((node, i) => {
    return `<div class="chain-node">
      <input type="text" value="${esc(node)}" data-chain="${i}" style="flex:1;border:1px solid rgba(78,156,173,.3);border-radius:10px;padding:8px 12px;font-size:14px">
      ${i < (d.chain || []).length - 1 ? '<span class="arrow2">→</span>' : ''}
      <a href="#" data-del-chain="${i}" style="color:var(--coral);text-decoration:none">×</a>
    </div>`;
  }).join('') + `<button class="btn btn-sec" id="chain-add">＋ 添加节点</button>`;

  // 逆向思维
  const reverseQs = ['如果它完全相反呢？', '如果结果先发生呢？', '如果缺席的东西成为主体呢？', '如果从物而不是人的视角观看呢？'];
  const reverseHtml = reverseQs.map((q, i) => {
    const val = d.reverse[i] || '';
    return `<div class="field-gap"><label class="field">${q}</label><textarea data-reverse="${i}" placeholder="记录反向方案…">${esc(val)}</textarea></div>`;
  }).join('');

  // 收敛思维
  const criteria = ['相关性', '独特性', '可视觉化', '延展性', '落地性'];
  const convergeHtml = criteria.map((c, ci) => {
    const score = d.converge[ci] || 0;
    let dots = '';
    for (let s = 1; s <= 5; s++) dots += `<button type="button" class="dot ${s <= score ? 'on' : ''}" aria-label="${c} ${s} 分" aria-pressed="${s === score}" data-converge="${ci}|${s}">${s}</button>`;
    return `<div class="score-row"><div class="criteria">${c}</div><div class="score-dots">${dots}</div></div>`;
  }).join('');

  el.innerHTML = `
    <div class="detail-wrap">
      <a class="back" href="#" data-back="detail">← 返回</a>
      <div class="detail-card glass">
        <h2 style="margin:0 0 4px">创作深化</h2>
        <div class="field-gap" style="margin-top:14px">
          <label class="field">创作主题</label>
          <input type="text" id="deepen-theme" value="${esc(d.theme)}">
        </div>

        <div class="deepen-block">
          <h3>① 扩散法 · 主题 → 联想维度 → 可创作元素</h3>
          ${spreadHtml}
        </div>

        <div class="deepen-block">
          <h3>② 接龙法 · 原始主题 → 联想 → 视觉语言 → 创作形式</h3>
          <p style="color:var(--sub);font-size:12px">示例：解压 → 回弹 → 软绵绵 → 圆润透明 → 果冻</p>
          <div id="chain-list">${chainHtml}</div>
        </div>

        <div class="deepen-block">
          <h3>③ 逆向思维</h3>
          ${reverseHtml}
        </div>

        <div class="deepen-block">
          <h3>④ 收敛思维 · 按 1—5 分评估</h3>
          ${convergeHtml}
        </div>

        <div class="detail-actions">
          <button class="btn btn-primary" id="deepen-save">保存草稿</button>
          <button class="btn btn-ghost" id="deepen-card">生成创作起点卡</button>
        </div>
      </div>
    </div>`;
  show('deepen');

  el.querySelector('[data-back="detail"]').addEventListener('click', (e) => {
    e.preventDefault();
    if (deepenIds.length === 1) showDetail(deepenIds[0]); else openPond();
  });
  el.querySelector('#deepen-theme').addEventListener('input', (e) => { d.theme = e.target.value; });
  el.querySelector('#chain-add').addEventListener('click', () => { d.chain.push(''); renderDeepen(); });
  el.querySelector('#deepen-save').addEventListener('click', saveDeepen);
  el.querySelector('#deepen-card').addEventListener('click', generateCard);

  // 扩散添加
  el.querySelectorAll('[data-add-spread]').forEach(i => {
    i.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && e.target.value.trim()) {
        const dim = e.target.dataset.addSpread;
        if (!d.spread[dim]) d.spread[dim] = [];
        d.spread[dim].push(e.target.value.trim());
        e.target.value = '';
        renderDeepen();
      }
    });
  });
  el.querySelectorAll('[data-del-spread]').forEach(a => {
    a.addEventListener('click', (e) => {
      e.preventDefault();
      const [dim, idx] = a.dataset.delSpread.split('|');
      d.spread[dim].splice(parseInt(idx), 1);
      renderDeepen();
    });
  });
  // 接龙编辑/删除
  el.querySelectorAll('[data-chain]').forEach(i => {
    i.addEventListener('input', (e) => { d.chain[parseInt(e.target.dataset.chain)] = e.target.value; });
  });
  el.querySelectorAll('[data-del-chain]').forEach(a => {
    a.addEventListener('click', (e) => {
      e.preventDefault();
      d.chain.splice(parseInt(a.dataset.delChain), 1);
      renderDeepen();
    });
  });
  // 逆向
  el.querySelectorAll('[data-reverse]').forEach(i => {
    i.addEventListener('input', (e) => { d.reverse[parseInt(e.target.dataset.reverse)] = e.target.value; });
  });
  // 收敛
  el.querySelectorAll('[data-converge]').forEach(dot => {
    dot.addEventListener('click', () => {
      const [ci, s] = dot.dataset.converge.split('|').map(Number);
      d.converge[ci] = s;
      renderDeepen();
    });
  });
}

async function saveDeepen() {
  // 从输入框收集最新值
  const themeEl = document.getElementById('deepen-theme');
  if (themeEl) deepenDraft.theme = themeEl.value;
  // reverse 收集
  document.querySelectorAll('[data-reverse]').forEach(i => { deepenDraft.reverse[parseInt(i.dataset.reverse)] = i.value; });
  await store.saveCreate(deepenDraft);
  toast('创作草稿已保存');
}

async function generateCard() {
  await saveDeepen();
  renderCard();
}

/* ================= 起点卡 ================= */
function renderCard() {
  const d = deepenDraft;
  // 计算视觉母题/色彩材质/场景行为 从 spread
  const spread = d.spread;
  const motif = (spread['形态'] || []).join('、') || '';
  const colorMat = ((spread['氛围'] || [])).join('、') || '';
  const sceneAct = ((spread['空间'] || []).concat(spread['行为'] || [])).join('、') || '';
  const meaning = (spread['意义'] || []).join('、') || '';
  const chain = (d.chain || []).join(' → ');

  // 候选方向（逆向 + 链末端 + 收敛高分维度）
  const candidates = [];
  (d.reverse || []).filter(Boolean).forEach(r => candidates.push({ t: '逆向', v: r }));
  if (chain) candidates.push({ t: '接龙', v: chain });
  const maxScoreIdx = (d.converge || []).indexOf(Math.max(...(d.converge || [0])));
  if (maxScoreIdx >= 0 && (d.converge[maxScoreIdx] || 0) >= 3) {
    const criteria = ['相关性', '独特性', '可视觉化', '延展性', '落地性'];
    candidates.push({ t: '收敛优势', v: criteria[maxScoreIdx] });
  }

  const el = document.getElementById('view-deepen');
  el.innerHTML = `
    <div class="detail-wrap">
      <a class="back" href="#" id="card-back">← 返回深化</a>
      <div class="card-export" id="card-export">
        <h2>${esc(d.theme || '未命名创作')}</h2>
        <div class="ce-sub">创作起点卡 · 状态：${esc(d.status || '酝酿中')}</div>
        <div class="ce-row"><div class="ce-label">原始记录引用</div><div class="ce-val">${esc((d.sourceIds || []).length)} 条灵感</div></div>
        <div class="ce-row"><div class="ce-label">核心感受（选填）</div><div class="ce-val">${esc(meaning)}</div></div>
        <div class="ce-row"><div class="ce-label">视觉母题</div><div class="ce-val">${esc(motif)}</div></div>
        <div class="ce-row"><div class="ce-label">色彩与材质</div><div class="ce-val">${esc(colorMat)}</div></div>
        <div class="ce-row"><div class="ce-label">场景与行为</div><div class="ce-val">${esc(sceneAct)}</div></div>
        <div class="ce-row"><div class="ce-label">创作媒介</div><div class="ce-val" id="card-medium"></div></div>
        <div class="ce-row"><div class="ce-label">候选方向（最多三个）</div><div class="ce-val">${candidates.slice(0, 3).map((c, i) => `${i + 1}. [${c.t}] ${esc(c.v)}`).join('<br>')}</div></div>
        <div class="ce-action"><div class="ce-label">一个可以立即执行的小行动</div><div class="ce-val" id="card-action"></div></div>
      </div>
      <div class="detail-actions" style="margin-top:16px;justify-content:center">
        <button class="btn btn-primary" id="card-export-btn">导出图片</button>
        <button class="btn btn-ghost" id="card-edit">继续编辑</button>
        <button class="btn btn-ghost" id="card-status">标记状态</button>
      </div>
    </div>`;
  show('deepen');

  document.getElementById('card-back').addEventListener('click', (e) => { e.preventDefault(); renderDeepen(); });
  document.getElementById('card-action').textContent = deriveAction(candidates);
  document.getElementById('card-medium').textContent = d.chain?.filter(Boolean).at(-1) || '尚未确定，可回到深化页补充接龙';
  document.getElementById('card-export-btn').addEventListener('click', exportCardImage);
  document.getElementById('card-edit').addEventListener('click', () => renderDeepen());
  document.getElementById('card-status').addEventListener('click', () => {
    const statuses = ['酝酿中', '正在创作', '已完成'];
    const cur = statuses.indexOf(d.status || '酝酿中');
    d.status = statuses[(cur + 1) % statuses.length];
    saveDeepen();
    renderCard();
  });
}

/* ================= 起点卡导出（Canvas 自绘） ================= */
// 颜色常量与设计 token 同步 CSS 变量
const CARD_TOKEN = {
  ink: '#173B47',
  sub: '#5F7E87',
  deep: '#357F91',
  lake: '#4E9CAD',
  koi: '#F47A4D',
  coral: '#E5523A',
  amber: '#F5B942',
  apricot: '#FFD9B8',
  cream: '#FFF0C7',
  pale: '#D8EEF2',
  bg: '#FFFFFF',
  card: '#FBFEFF',
  line: 'rgba(78,156,173,.22)'
};

/* 文字按宽度自动换行（中文按字符计算宽度） */
function drawWrappedText(ctx, text, x, y, maxWidth, lineHeight) {
  if (!text) return 0;
  const str = String(text);
  const lines = [];
  let line = '';
  for (let i = 0; i < str.length; i++) {
    const ch = str[i];
    const test = line + ch;
    // 估算宽度：英文按字符宽一些，中文等宽
    const w = ctx.measureText(test).width;
    if (w > maxWidth && line) { lines.push(line); line = ch; }
    else line = test;
    // 遇到显式换行也立即断行
    if (ch === '\n') { lines.push(line.slice(0, -1)); line = ''; }
  }
  if (line) lines.push(line);
  lines.forEach((ln, idx) => ctx.fillText(ln, x, y + idx * lineHeight));
  return lines.length * lineHeight;
}

/* 圆角矩形路径 */
function roundRect(ctx, x, y, w, h, r) {
  const rr = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + rr, y);
  ctx.arcTo(x + w, y, x + w, y + h, rr);
  ctx.arcTo(x + w, y + h, x, y + h, rr);
  ctx.arcTo(x, y + h, x, y, rr);
  ctx.arcTo(x, y, x + w, y, rr);
  ctx.closePath();
}

/* 根据主题色生成状态条 */
function statusPalette(status) {
  if (status === '正在创作') return { bg: '#FFE9D9', fg: '#8a4a1e', dot: CARD_TOKEN.koi };
  if (status === '已完成')   return { bg: '#D8EEF2', fg: CARD_TOKEN.deep, dot: CARD_TOKEN.deep };
  return { bg: CARD_TOKEN.cream, fg: '#8a6a20', dot: CARD_TOKEN.amber }; // 酝酿中
}

/* 把字段卡片绘制到 ctx 上，自适应高度，返回绘制终点 y */
function drawFieldCard(ctx, x, y, w, label, value, fontSize = 16, lineHeight = 26) {
  const padX = 18, padY = 14, labelH = 14, labelGap = 8;
  // 测量行数
  ctx.font = `${fontSize}px -apple-system,"PingFang SC","Microsoft YaHei",sans-serif`;
  const lines = wrapText(ctx, value || '—', w - padX * 2, fontSize, lineHeight);
  const valueH = lines * lineHeight;
  const blockH = padY + labelH + labelGap + Math.max(valueH, lineHeight) + padY - 6;
  // 背景
  ctx.fillStyle = CARD_TOKEN.card;
  roundRect(ctx, x, y, w, blockH, 14); ctx.fill();
  // label baseline
  ctx.font = '600 12px -apple-system,"PingFang SC","Microsoft YaHei",sans-serif';
  ctx.fillStyle = CARD_TOKEN.deep;
  ctx.fillText(label, x + padX, y + padY + labelH - 2);
  // value 基线：第一行
  ctx.font = `${fontSize}px -apple-system,"PingFang SC","Microsoft YaHei",sans-serif`;
  ctx.fillStyle = CARD_TOKEN.ink;
  const valY = y + padY + labelH + labelGap + lineHeight;
  drawWrappedText(ctx, value || '—', x + padX, valY, w - padX * 2, lineHeight);
  return blockH;
}

/* 仅测量高度（保持与 drawFieldCard 一致） */
function measureFieldHeight(ctx, w, value, fontSize = 16, lineHeight = 26) {
  const padX = 18, padY = 14, labelH = 14, labelGap = 8;
  ctx.font = `${fontSize}px -apple-system,"PingFang SC","Microsoft YaHei",sans-serif`;
  const lines = wrapText(ctx, value || '—', w - padX * 2, fontSize, lineHeight);
  const valueH = lines * lineHeight;
  return padY + labelH + labelGap + Math.max(valueH, lineHeight) + padY - 6;
}

async function exportCardImage() {
  const d = deepenDraft;
  // 准备展示数据
  const spread = d.spread || {};
  const motif   = (spread['形态'] || []).join('、');
  const colorMat= (spread['氛围'] || []).join('、');
  const sceneAct= ((spread['空间'] || []).concat(spread['行为'] || [])).join('、');
  const meaning = (spread['意义'] || []).join('、');
  const chain   = (d.chain || []).filter(Boolean).join(' → ');
  const candidates = [];
  (d.reverse || []).filter(Boolean).forEach(r => candidates.push({ t: '逆向', v: r }));
  if (chain) candidates.push({ t: '接龙', v: chain });
  const maxScoreIdx = (d.converge || []).indexOf(Math.max(...(d.converge || [0])));
  if (maxScoreIdx >= 0 && (d.converge[maxScoreIdx] || 0) >= 3) {
    const criteria = ['相关性', '独特性', '可视觉化', '延展性', '落地性'];
    candidates.push({ t: '收敛优势', v: criteria[maxScoreIdx] });
  }
  candidates.slice(0, 3).forEach((c, i) => { c.idx = i + 1; });
  const action = deriveAction(candidates);
  const dateStr = new Date().toLocaleDateString('zh-CN', { year: 'numeric', month: 'long', day: 'numeric' });
  const sourceCount = (d.sourceIds || []).length;
  const palette = statusPalette(d.status || '酝酿中');

  // 布局参数
  const W = 640;
  const padOuter = 28;
  const innerX = padOuter;
  const innerW = W - padOuter * 2;
  const dpr = Math.max(2, window.devicePixelRatio || 1);

  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d');
  // 先以 1x 计算高度
  ctx.font = '16px -apple-system,"PingFang SC","Microsoft YaHei",sans-serif';

  // 预计算各字段绘制高度
  let total = 86 + 22 + 36 + 18 + 16; // 顶部品牌栏 + 主题块 + 分隔
  const fields = [
    { l: '视觉母题', v: motif },
    { l: '色彩与材质', v: colorMat },
    { l: '场景与行为', v: sceneAct },
    { l: '意义', v: meaning }
  ];
  const fieldFontSize = 15, fieldLineH = 24, fieldGap = 12;
  const fieldHeights = fields.map(f => measureFieldHeight(ctx, innerW, f.v, fieldFontSize, fieldLineH));
  total += fieldHeights.reduce((a, b) => a + b + fieldGap, 0) - fieldGap;
  // 候选方向
  total += 28 + (candidates.length || 1) * 32 + 12;
  // 行动
  total += 88 + 32;
  // 底栏
  total += 32 + 28;

  // Account for wrapped text in long themes, candidate directions and actions.
  const extraTheme = Math.max(0, wrapText(ctx, d.theme || '未命名创作', innerW, 30, 36) - 1) * 36;
  const extraCandidates = candidates.reduce((sum, c) => sum + Math.max(0, wrapText(ctx, c.v, innerW - 150, 15, 22) - 1) * 22, 0);
  const extraAction = Math.max(0, wrapText(ctx, action, innerW - 36, 15, 22) - 1) * 22;
  const H = total + extraTheme + extraCandidates + extraAction + 24;
  canvas.width = W * dpr; canvas.height = H * dpr;
  canvas.style.width = W + 'px'; canvas.style.height = H + 'px';
  ctx.scale(dpr, dpr);

  // 背景
  ctx.fillStyle = CARD_TOKEN.bg;
  ctx.fillRect(0, 0, W, H);

  // 顶部品牌栏
  ctx.fillStyle = CARD_TOKEN.pale;
  roundRect(ctx, 0, 0, W, 72, 0);
  ctx.fill();
  // logo 圆点
  ctx.fillStyle = CARD_TOKEN.koi;
  ctx.beginPath();
  ctx.arc(36, 36, 12, 0, Math.PI * 2);
  ctx.fill();
  // 文字
  ctx.fillStyle = CARD_TOKEN.ink;
  ctx.font = '700 18px -apple-system,"PingFang SC","Microsoft YaHei",sans-serif';
  ctx.fillText('灵感池塘 · 创作起点卡', 60, 32);
  ctx.font = '13px -apple-system,"PingFang SC","Microsoft YaHei",sans-serif';
  ctx.fillStyle = CARD_TOKEN.sub;
  ctx.fillText('把碎片先留下来，方向让它自己长出来。', 60, 54);
  // 日期
  ctx.font = '12px -apple-system,"PingFang SC","Microsoft YaHei",sans-serif';
  ctx.fillStyle = CARD_TOKEN.sub;
  const dtxt = dateStr;
  ctx.fillText(dtxt, W - padOuter - ctx.measureText(dtxt).width, 40);

  // 状态徽章
  const badgeText = d.status || '酝酿中';
  ctx.font = '600 12px -apple-system,"PingFang SC","Microsoft YaHei",sans-serif';
  const bw = ctx.measureText(badgeText).width + 24;
  const bx = W - padOuter - bw, by = 56;
  ctx.fillStyle = palette.bg;
  roundRect(ctx, bx, by, bw, 18, 9); ctx.fill();
  ctx.fillStyle = palette.fg;
  ctx.beginPath();
  ctx.arc(bx + 10, by + 9, 3, 0, Math.PI * 2); ctx.fill();
  ctx.fillText(badgeText, bx + 18, by + 13);

  // 主题块
  let cy = 88;
  ctx.font = '600 12px -apple-system,"PingFang SC","Microsoft YaHei",sans-serif';
  ctx.fillStyle = CARD_TOKEN.sub;
  ctx.fillText('创作主题 · ' + sourceCount + ' 条灵感', innerX, cy + 12);
  cy += 22;
  ctx.font = '800 30px -apple-system,"PingFang SC","Microsoft YaHei",sans-serif';
  ctx.fillStyle = CARD_TOKEN.ink;
  const themeText = d.theme || '未命名创作';
  const themeH = drawWrappedText(ctx, themeText, innerX, cy + 22, innerW, 36);
  cy += themeH + 12;

  // 分隔线
  ctx.strokeStyle = CARD_TOKEN.line;
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(innerX, cy + 4); ctx.lineTo(innerX + innerW, cy + 4);
  ctx.stroke();
  cy += 16;

  // 字段卡
  fields.forEach((f, i) => {
    const blockH = drawFieldCard(ctx, innerX, cy, innerW, f.l, f.v, fieldFontSize, fieldLineH);
    cy += blockH + 12;
  });

  // 候选方向
  ctx.font = '600 13px -apple-system,"PingFang SC","Microsoft YaHei",sans-serif';
  ctx.fillStyle = CARD_TOKEN.deep;
  ctx.fillText('候选方向', innerX, cy + 14);
  cy += 28;
  if (!candidates.length) {
    ctx.font = '14px -apple-system,"PingFang SC","Microsoft YaHei",sans-serif';
    ctx.fillStyle = CARD_TOKEN.sub;
    ctx.fillText('暂未生成方向，可回到深化页补充灵感。', innerX, cy + 18);
    cy += 32;
  } else {
    candidates.forEach(c => {
      // 序号圆
      ctx.fillStyle = CARD_TOKEN.apricot;
      ctx.beginPath();
      ctx.arc(innerX + 12, cy + 16, 12, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = '#8a4a1e';
      ctx.font = '700 12px -apple-system,"PingFang SC","Microsoft YaHei",sans-serif';
      ctx.fillText(String(c.idx), innerX + 8, cy + 20);
      // 类型标签
      const tag = '[' + c.t + ']';
      ctx.font = '600 12px -apple-system,"PingFang SC","Microsoft YaHei",sans-serif';
      const tagW = ctx.measureText(tag).width;
      const tagX = innerX + 32, tagY = cy + 8;
      ctx.fillStyle = CARD_TOKEN.pale;
      roundRect(ctx, tagX, tagY, tagW + 16, 18, 9); ctx.fill();
      ctx.fillStyle = CARD_TOKEN.deep;
      ctx.fillText(tag, tagX + 8, tagY + 13);
      // 内容
      ctx.font = '15px -apple-system,"PingFang SC","Microsoft YaHei",sans-serif';
      ctx.fillStyle = CARD_TOKEN.ink;
      const valX = tagX + tagW + 24;
      const valW = innerW - (valX - innerX) - 8;
      const used = drawWrappedText(ctx, c.v, valX, cy + 20, valW, 22);
      cy += Math.max(28, used + 6);
    });
    cy += 4;
  }

  // 行动建议
  const actionY = cy + 4;
  const actionH = Math.max(76, wrapText(ctx, action, innerW - 36, 15, 22) * 22 + 44);
  ctx.fillStyle = CARD_TOKEN.cream;
  roundRect(ctx, innerX, actionY, innerW, actionH, 14); ctx.fill();
  // 左侧色条
  ctx.fillStyle = CARD_TOKEN.koi;
  ctx.fillRect(innerX, actionY + 8, 4, actionH - 16);
  ctx.font = '700 12px -apple-system,"PingFang SC","Microsoft YaHei",sans-serif';
  ctx.fillStyle = '#8a6a20';
  ctx.fillText('一个可以立即执行的小行动', innerX + 18, actionY + 22);
  ctx.font = '15px -apple-system,"PingFang SC","Microsoft YaHei",sans-serif';
  ctx.fillStyle = CARD_TOKEN.ink;
  const aH = drawWrappedText(ctx, action, innerX + 18, actionY + 44, innerW - 36, 22);
  cy = actionY + Math.max(actionH, aH + 28) + 16;

  // 底栏
  ctx.fillStyle = CARD_TOKEN.pale;
  ctx.fillRect(0, H - 36, W, 36);
  ctx.font = '12px -apple-system,"PingFang SC","Microsoft YaHei",sans-serif';
  ctx.fillStyle = CARD_TOKEN.sub;
  ctx.fillText('灵感池塘 · 让碎片慢慢相遇', innerX, H - 14);
  const tip = '由灵感池塘自动生成';
  ctx.fillText(tip, W - padOuter - ctx.measureText(tip).width, H - 14);

  // 触发下载
  try {
    const url = canvas.toDataURL('image/png');
    downloadURL(url, '创作起点卡-' + (themeText || '未命名').slice(0, 10) + '.png');
    toast('图片已导出');
  } catch (e) {
    toast('导出失败：' + e.message, true);
  }
}

/* 工具：按宽度换行（按字符测量，返回行数） */
function wrapText(ctx, text, maxWidth, fontSize, lineHeight) {
  ctx.font = `${fontSize}px -apple-system,"PingFang SC","Microsoft YaHei",sans-serif`;
  if (!text) return 1;
  const lines = [];
  let line = '';
  for (let i = 0; i < text.length; i++) {
    const test = line + text[i];
    if (ctx.measureText(test).width > maxWidth && line) { lines.push(line); line = text[i]; }
    else line = test;
  }
  if (line) lines.push(line);
  return lines.length || 1;
}

/* 根据候选方向自动生成一条最小行动建议 */
function deriveAction(candidates) {
  if (!candidates.length) return '回到池塘页重新选 2-3 条碎片，再走一遍扩散 → 接龙 → 收敛。';
  const c = candidates[0];
  if (c.t === '逆向') return '用 30 分钟把「' + c.v.slice(0, 30) + '」反着演一遍，画 4 张草稿对比。';
  if (c.t === '接龙') return '把接龙的最后一环「' + (c.v.split('→').pop() || '').trim().slice(0, 30) + '」找 3 个真实参考。';
  if (c.t === '收敛优势') return '用今天 1 小时，以「' + c.v + '」为唯一标准重新审视这批素材。';
  return '挑出 1 个最打动你的方向，今晚写 5 行创作草案。';
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
