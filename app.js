'use strict';

const PDFJS_CDN = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/';
pdfjsLib.GlobalWorkerOptions.workerSrc = PDFJS_CDN + 'pdf.worker.min.js';

const DISPLAY_SCALE = 1.5;
const EXPORT_SCALE = 2.5;

const PREFECTURES = '北海道|青森県|岩手県|宮城県|秋田県|山形県|福島県|茨城県|栃木県|群馬県|埼玉県|千葉県|東京都|神奈川県|新潟県|富山県|石川県|福井県|山梨県|長野県|岐阜県|静岡県|愛知県|三重県|滋賀県|京都府|大阪府|兵庫県|奈良県|和歌山県|鳥取県|島根県|岡山県|広島県|山口県|徳島県|香川県|愛媛県|高知県|福岡県|佐賀県|長崎県|熊本県|大分県|宮崎県|鹿児島県|沖縄県';
const LABELS = '氏名|お名前|名前|フリガナ|ふりがな|住所|現住所|本籍|生年月日|勤務先|保護者';

// Patterns run against normalized text (full-width ASCII -> half-width, dash variants -> '-').
// A capture group, when present, marks the part to redact.
const CATEGORIES = [
  { id: 'mynumber', label: 'マイナンバー', on: true,
    re: /(?<!\d)\d{4}[ -]?\d{4}[ -]?\d{4}(?![\d-])/g,
    valid: s => isValidMyNumber(s.replace(/\D/g, '')) },
  { id: 'card', label: 'クレジットカード番号', on: true,
    re: /(?<!\d)\d{4}[ -]?\d{4}[ -]?\d{4}[ -]?\d{4}(?![\d-])/g,
    valid: s => luhn(s.replace(/\D/g, '')) },
  { id: 'phone', label: '電話番号', on: true,
    re: /(?<![\d-])(?:\+81[ -]?|0)\d{1,4}[ -]?\(?\d{1,4}\)?[ -]?\d{3,4}(?![\d-])/g,
    valid: s => { const d = s.replace(/\D/g, ''); return s.startsWith('+') ? d.length >= 11 && d.length <= 12 : d.length >= 10 && d.length <= 11; } },
  { id: 'postal', label: '郵便番号', on: true,
    re: /(?:〒\s?)?(?<![\d-])\d{3}-\d{4}(?![\d-])/g },
  { id: 'email', label: 'メールアドレス', on: true,
    re: /[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g },
  { id: 'address', label: '住所', on: true,
    re: new RegExp(`(?:${PREFECTURES})[^\\s、,。]{2,50}`, 'g') },
  { id: 'label', label: '項目名の後ろ（氏名・住所など）', on: true,
    re: new RegExp(`(?:${LABELS})\\s*[:]?\\s*([^\\s:]{1,25}(?: [^\\s:]{1,25})?)`, 'dg') },
  { id: 'date', label: '日付（生年月日など）', on: false,
    re: /(?:(?:19|20)\d{2}|(?:明治|大正|昭和|平成|令和)\s?(?:\d{1,2}|元))\s?[年/.-]\s?\d{1,2}\s?[月/.-]\s?\d{1,2}日?/g },
];

const state = {
  pdf: null,
  fileName: '',
  pages: [],      // { num, page, width, height, text, el, overlay, noText }
  hits: [],       // { id, cat, pageNum, text, rects: [{x,y,w,h}] in scale-1 page units, on }
  catOn: Object.fromEntries(CATEGORIES.map(c => [c.id, c.on])),
};
let nextId = 1;

const $ = id => document.getElementById(id);

// ---------- validation helpers ----------

function isValidMyNumber(d) {
  if (d.length !== 12) return false;
  let sum = 0;
  for (let n = 1; n <= 11; n++) {
    const p = Number(d[11 - n]);
    const q = n <= 6 ? n + 1 : n - 5;
    sum += p * q;
  }
  const r = sum % 11;
  return Number(d[11]) === (r <= 1 ? 0 : 11 - r);
}

function luhn(d) {
  if (d.length !== 16) return false;
  let sum = 0;
  for (let i = 0; i < d.length; i++) {
    let v = Number(d[d.length - 1 - i]);
    if (i % 2 === 1) { v *= 2; if (v > 9) v -= 9; }
    sum += v;
  }
  return sum % 10 === 0;
}

// Same-length normalization so match indices map back to the original characters.
function normalize(s) {
  let out = '';
  for (const ch of s) {
    const c = ch.codePointAt(0);
    if (c >= 0xff01 && c <= 0xff5e) out += String.fromCharCode(c - 0xfee0);
    else if (c === 0x3000) out += ' ';
    else if ('‐‑‒–—―−ｰー－'.includes(ch)) out += '-';
    else out += ch;
  }
  return out;
}

function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// ---------- loading ----------

async function loadFile(file) {
  // パソコンによっては PDF の種類が空で渡されるので、拡張子でも判断する
  if (!file || (file.type !== 'application/pdf' && !/\.pdf$/i.test(file.name))) {
    showStatus('PDFファイルを選んでください', 2500);
    return;
  }
  showStatus('読み込み中…');
  try {
    const data = new Uint8Array(await file.arrayBuffer());
    const pdf = await pdfjsLib.getDocument({
      data,
      cMapUrl: PDFJS_CDN + 'cmaps/',
      cMapPacked: true,
      standardFontDataUrl: PDFJS_CDN + 'standard_fonts/',
    }).promise;

    state.pdf = pdf;
    state.fileName = file.name;
    state.pages = [];
    state.hits = [];
    $('pages').innerHTML = '';
    $('fileName').textContent = `${file.name}（${pdf.numPages}ページ）`;

    for (let n = 1; n <= pdf.numPages; n++) {
      showStatus(`ページを描画中… ${n} / ${pdf.numPages}`);
      state.pages.push(await renderPage(pdf, n));
    }
    detectAll();
    $('redetect').disabled = false;
    $('exportBtn').disabled = false;
    hideStatus();
  } catch (err) {
    console.error(err);
    showStatus('PDFを開けませんでした: ' + err.message, 4000);
  }
}

async function renderPage(pdf, num) {
  const page = await pdf.getPage(num);
  const vp1 = page.getViewport({ scale: 1 });
  const dpr = window.devicePixelRatio || 1;
  const vp = page.getViewport({ scale: DISPLAY_SCALE * dpr });

  const el = document.createElement('div');
  el.className = 'page';
  el.style.maxWidth = `${vp1.width * DISPLAY_SCALE}px`;
  const canvas = document.createElement('canvas');
  canvas.width = vp.width;
  canvas.height = vp.height;
  const overlay = document.createElement('div');
  overlay.className = 'overlay';
  const label = document.createElement('div');
  label.className = 'label';
  label.textContent = `${num} ページ`;
  el.append(label, canvas, overlay);
  $('pages').append(el);

  await page.render({ canvasContext: canvas.getContext('2d'), viewport: vp }).promise;

  const text = await extractText(page, vp1);
  const p = { num, page, width: vp1.width, height: vp1.height, text, el, overlay, noText: text.str.trim() === '' };
  if (p.noText) {
    const w = document.createElement('span');
    w.className = 'warn';
    w.textContent = '文字データなし（スキャン画像？）— 手動で囲ってください';
    label.append(w);
  }
  attachDrawing(p);
  return p;
}

// Builds one string per page plus a parallel array mapping each char to its source text item.
async function extractText(page, vp1) {
  const tc = await page.getTextContent();
  let str = '';
  const map = [];
  let prev = null;
  for (const it of tc.items) {
    if (!('str' in it)) continue;
    const geo = itemGeometry(it, vp1);
    if (prev && !prev.it.hasEOL && it.str) {
      const sameLine = Math.abs(geo.baseY - prev.geo.baseY) < prev.geo.fontH * 0.5;
      if (!sameLine) { str += '\n'; map.push(null); }
      else if (geo.x - (prev.geo.x + prev.geo.w) > prev.geo.fontH) { str += ' '; map.push(null); }
    }
    for (let i = 0; i < it.str.length; i++) map.push({ it, geo, i });
    str += it.str;
    if (it.hasEOL) { str += '\n'; map.push(null); }
    if (it.str) prev = { it, geo };
  }
  return { str, norm: normalize(str), map };
}

function itemGeometry(it, vp1) {
  const tx = pdfjsLib.Util.transform(vp1.transform, it.transform);
  const fontH = Math.hypot(tx[2], tx[3]) || 10;
  // Distribute the item width over its characters: full-width glyphs ~1em, others ~0.55em.
  // One weight per UTF-16 unit (the low half of a surrogate pair gets 0), so offsets line up with the
  // per-unit indices used in extractText / rangeToRects even for rare kanji and emoji.
  const weights = [];
  for (let i = 0; i < it.str.length; i++) {
    const c = it.str.charCodeAt(i);
    if (c >= 0xdc00 && c <= 0xdfff) { weights.push(0); continue; }
    const ch = String.fromCodePoint(it.str.codePointAt(i));
    weights.push((ch.codePointAt(0) > 0x2e7f && !(ch >= '｡' && ch <= 'ﾟ')) ? 1 : 0.55);
  }
  const total = weights.reduce((a, b) => a + b, 0) || 1;
  const offsets = [0];
  for (const w of weights) offsets.push(offsets[offsets.length - 1] + w / total);
  return { x: tx[4], baseY: tx[5], fontH, w: it.width * vp1.scale, offsets };
}

// ---------- detection ----------

function detectAll() {
  state.hits = state.hits.filter(h => h.cat === 'manual');
  const keywords = $('keywords').value.split(/[,、\n]/).map(s => normalize(s.trim())).filter(Boolean);
  const kwRe = keywords.length ? new RegExp(keywords.map(escapeRegExp).join('|'), 'g') : null;

  for (const p of state.pages) {
    const { str, norm } = p.text;
    for (const cat of CATEGORIES) {
      for (const m of norm.matchAll(cat.re)) {
        if (cat.valid && !cat.valid(m[0])) continue;
        let [start, end] = [m.index, m.index + m[0].length];
        if (m.indices && m.indices[1]) [start, end] = m.indices[1];
        addHit(p, cat.id, start, end, str.slice(start, end));
      }
    }
    if (kwRe) {
      for (const m of norm.matchAll(kwRe)) addHit(p, 'keyword', m.index, m.index + m[0].length, str.slice(m.index, m.index + m[0].length));
    }
  }
  renderAll();
}

function addHit(p, cat, start, end, text) {
  const rects = rangeToRects(p.text.map, start, end);
  if (!rects.length) return;
  const on = cat === 'keyword' ? true : state.catOn[cat];
  state.hits.push({ id: nextId++, cat, pageNum: p.num, text: text.trim(), rects, on });
}

function rangeToRects(map, start, end) {
  const groups = new Map();
  for (let k = start; k < end; k++) {
    const m = map[k];
    if (!m) continue;
    const g = groups.get(m.it) || { geo: m.geo, lo: m.i, hi: m.i };
    g.lo = Math.min(g.lo, m.i);
    g.hi = Math.max(g.hi, m.i);
    groups.set(m.it, g);
  }
  const pad = 1.5;
  return [...groups.values()].map(({ geo, lo, hi }) => ({
    x: geo.x + geo.offsets[lo] * geo.w - pad,
    y: geo.baseY - geo.fontH * 0.95 - pad,
    w: (geo.offsets[hi + 1] - geo.offsets[lo]) * geo.w + pad * 2,
    h: geo.fontH * 1.2 + pad * 2,
  }));
}

// ---------- rendering overlay + sidebar ----------

function renderAll() {
  for (const p of state.pages) {
    p.overlay.innerHTML = '';
    for (const h of state.hits.filter(h => h.pageNum === p.num)) {
      for (const r of h.rects) {
        const b = document.createElement('div');
        b.className = 'box' + (h.cat === 'manual' ? ' manual' : '') + (h.on ? '' : ' off');
        b.dataset.id = h.id;
        b.title = `${catLabel(h.cat)}: ${h.text}`;
        Object.assign(b.style, {
          left: `${(r.x / p.width) * 100}%`,
          top: `${(r.y / p.height) * 100}%`,
          width: `${(r.w / p.width) * 100}%`,
          height: `${(r.h / p.height) * 100}%`,
        });
        p.overlay.append(b);
      }
    }
  }
  renderCats();
  renderList();
}

function catLabel(id) {
  if (id === 'manual') return '手動';
  if (id === 'keyword') return 'キーワード';
  return CATEGORIES.find(c => c.id === id).label;
}

function renderCats() {
  const ul = $('cats');
  ul.innerHTML = '';
  for (const c of CATEGORIES) {
    const n = state.hits.filter(h => h.cat === c.id).length;
    const li = document.createElement('li');
    li.innerHTML = `<label><input type="checkbox" ${state.catOn[c.id] ? 'checked' : ''}> ${c.label}</label><span class="count">${n}</span>`;
    li.querySelector('input').addEventListener('change', e => {
      state.catOn[c.id] = e.target.checked;
      state.hits.filter(h => h.cat === c.id).forEach(h => { h.on = e.target.checked; });
      renderAll();
    });
    ul.append(li);
  }
}

function renderList() {
  const ul = $('list');
  ul.innerHTML = '';
  const active = state.hits.filter(h => h.on).length;
  $('totalCount').textContent = state.hits.length ? `${active} / ${state.hits.length}` : '';
  for (const h of state.hits) {
    const li = document.createElement('li');
    li.className = h.on ? '' : 'off';
    li.innerHTML = `<input type="checkbox" ${h.on ? 'checked' : ''}>
      <span class="text"></span>
      ${h.cat === 'manual' ? '<button class="del" title="削除">×</button>' : '<span></span>'}`;
    const t = li.querySelector('.text');
    t.textContent = h.text;
    const meta = document.createElement('span');
    meta.className = 'meta';
    meta.textContent = `${h.pageNum}ページ · ${catLabel(h.cat)}`;
    t.append(meta);
    li.querySelector('input').addEventListener('change', () => toggleHit(h.id));
    t.addEventListener('click', () => scrollToHit(h));
    const del = li.querySelector('.del');
    if (del) del.addEventListener('click', () => { state.hits = state.hits.filter(x => x !== h); renderAll(); });
    ul.append(li);
  }
}

function toggleHit(id) {
  const h = state.hits.find(x => x.id === id);
  if (h) { h.on = !h.on; renderAll(); }
}

function scrollToHit(h) {
  const boxes = document.querySelectorAll(`.box[data-id="${h.id}"]`);
  if (!boxes.length) return;
  boxes[0].scrollIntoView({ behavior: 'smooth', block: 'center' });
  boxes.forEach(b => { b.classList.remove('flash'); void b.offsetWidth; b.classList.add('flash'); });
}

// ---------- manual rectangles ----------

function attachDrawing(p) {
  const ov = p.overlay;
  let start = null;
  let ghost = null;

  const toPage = e => {
    const r = ov.getBoundingClientRect();
    return {
      x: ((e.clientX - r.left) / r.width) * p.width,
      y: ((e.clientY - r.top) / r.height) * p.height,
      px: e.clientX - r.left,
      py: e.clientY - r.top,
    };
  };

  ov.addEventListener('pointerdown', e => {
    if (e.target.classList.contains('box')) return;
    start = toPage(e);
    ghost = document.createElement('div');
    ghost.className = 'drawing';
    ov.append(ghost);
    ov.setPointerCapture(e.pointerId);
  });
  ov.addEventListener('pointermove', e => {
    if (!start) return;
    const c = toPage(e);
    Object.assign(ghost.style, {
      left: `${Math.min(start.px, c.px)}px`, top: `${Math.min(start.py, c.py)}px`,
      width: `${Math.abs(c.px - start.px)}px`, height: `${Math.abs(c.py - start.py)}px`,
    });
  });
  ov.addEventListener('pointerup', e => {
    if (!start) return;
    const c = toPage(e);
    ghost.remove();
    const rect = { x: Math.min(start.x, c.x), y: Math.min(start.y, c.y), w: Math.abs(c.x - start.x), h: Math.abs(c.y - start.y) };
    start = null;
    if (rect.w < 3 || rect.h < 3) return;
    state.hits.push({ id: nextId++, cat: 'manual', pageNum: p.num, text: '手動で追加した範囲', rects: [rect], on: true });
    renderAll();
  });
  ov.addEventListener('click', e => {
    if (e.target.classList.contains('box')) toggleHit(Number(e.target.dataset.id));
  });
}

// ---------- export ----------

async function exportPdf() {
  $('exportBtn').disabled = true;
  try {
    const out = await PDFLib.PDFDocument.create();
    out.setProducer('');
    out.setCreator('');
    for (const p of state.pages) {
      showStatus(`書き出し中… ${p.num} / ${state.pages.length}`);
      const vp = p.page.getViewport({ scale: EXPORT_SCALE });
      const canvas = document.createElement('canvas');
      canvas.width = Math.ceil(vp.width);
      canvas.height = Math.ceil(vp.height);
      const ctx = canvas.getContext('2d');
      await p.page.render({ canvasContext: ctx, viewport: vp }).promise;
      ctx.fillStyle = '#000';
      for (const h of state.hits) {
        if (!h.on || h.pageNum !== p.num) continue;
        for (const r of h.rects) ctx.fillRect(r.x * EXPORT_SCALE, r.y * EXPORT_SCALE, r.w * EXPORT_SCALE, r.h * EXPORT_SCALE);
      }
      const blob = await new Promise(res => canvas.toBlob(res, 'image/jpeg', 0.92));
      const img = await out.embedJpg(await blob.arrayBuffer());
      const page = out.addPage([p.width, p.height]);
      page.drawImage(img, { x: 0, y: 0, width: p.width, height: p.height });
    }
    const bytes = await out.save();
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([bytes], { type: 'application/pdf' }));
    a.download = state.fileName.replace(/\.pdf$/i, '') + '_黒塗り.pdf';
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 10000);
    showStatus('書き出しました', 2000);
  } catch (err) {
    console.error(err);
    showStatus('書き出しに失敗しました: ' + err.message, 4000);
  } finally {
    $('exportBtn').disabled = false;
  }
}

// ---------- status ----------

let statusTimer = null;
function showStatus(msg, ms) {
  const s = $('status');
  s.textContent = msg;
  s.hidden = false;
  clearTimeout(statusTimer);
  if (ms) statusTimer = setTimeout(hideStatus, ms);
}
function hideStatus() { $('status').hidden = true; }

// ---------- wiring ----------

$('fileInput').addEventListener('change', e => loadFile(e.target.files[0]));
const dz = $('dropzone');
dz.addEventListener('dragover', e => { e.preventDefault(); dz.classList.add('over'); });
dz.addEventListener('dragleave', () => dz.classList.remove('over'));
dz.addEventListener('drop', () => dz.classList.remove('over'));
document.addEventListener('dragover', e => e.preventDefault());
document.addEventListener('drop', e => { e.preventDefault(); if (e.dataTransfer.files[0]) loadFile(e.dataTransfer.files[0]); });
$('redetect').addEventListener('click', detectAll);
$('preview').addEventListener('change', e => $('pages').classList.toggle('preview', e.target.checked));
$('exportBtn').addEventListener('click', exportPdf);
// 「サンプルの PDF で試す」: ページを移らずに、そのままツールに読み込む
$('sampleLink').addEventListener('click', async e => {
  e.preventDefault();
  try {
    const blob = await (await fetch(e.currentTarget.href)).blob();
    loadFile(new File([blob], 'sample.pdf', { type: 'application/pdf' }));
  } catch (err) {
    showStatus('サンプルを読み込めませんでした', 3000);
  }
});
renderCats();
