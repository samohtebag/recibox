'use strict';
const L = RB_LIB;
const $ = (s, r = document) => r.querySelector(s);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const uid = () => (crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(36) + Math.random().toString(36).slice(2));
const lines = s => String(s || '').split('\n').map(x => x.trim()).filter(Boolean);

/* ============ storage ============ */
let _db;
const open = () => (_db ||= new Promise((res, rej) => {
  const r = indexedDB.open('recibox', 1);
  r.onupgradeneeded = () => r.result.createObjectStore('recipes', { keyPath: 'id' });
  r.onsuccess = () => res(r.result);
  r.onerror = () => rej(r.error);
}));
async function tx(mode, fn) {
  const d = await open();
  return new Promise((res, rej) => {
    const t = d.transaction('recipes', mode);
    const rq = fn(t.objectStore('recipes'));
    t.oncomplete = () => res(rq && rq.result);
    t.onerror = () => rej(t.error);
  });
}
const DB = {
  all: () => tx('readonly', s => s.getAll()),
  put: r => tx('readwrite', s => s.put(r)),
  del: id => tx('readwrite', s => s.delete(id)),
  clear: () => tx('readwrite', s => s.clear()),
  putMany: rs => tx('readwrite', s => { rs.forEach(r => s.put(r)); })
};
const store = {
  get(k, d) { try { return JSON.parse(localStorage.getItem('recibox.' + k)) ?? d; } catch { return d; } },
  set(k, v) { try { localStorage.setItem('recibox.' + k, JSON.stringify(v)); } catch { /* private mode */ } }
};
const DEFAULT_PROXIES = ['https://corsproxy.io/?url={url}', 'https://api.allorigins.win/raw?url={url}', 'https://api.codetabs.com/v1/proxy/?quest={url}'];
const settings = () => ({ proxies: DEFAULT_PROXIES, ...store.get('settings', {}) });

/* ============ state ============ */
const S = { recipes: [], q: '', tag: '', favOnly: false, srv: {}, draft: null, addTab: 'link', pasteUrl: '', pasteText: '', notice: '', busy: false, cookI: 0 };
const byId = id => S.recipes.find(r => r.id === id);
const blank = () => ({ id: uid(), title: '', image: '', sourceUrl: '', sourceName: '', servings: 0, prepMin: 0, cookMin: 0, ingredients: [], steps: [], tags: [], notes: '', favorite: false });
async function save(r) {
  r.updatedAt = Date.now(); r.createdAt ||= r.updatedAt;
  await DB.put(r);
  const i = S.recipes.findIndex(x => x.id === r.id);
  if (i < 0) S.recipes.unshift(r); else S.recipes[i] = r;
}

function toast(msg) {
  const t = $('#toast'); t.textContent = msg; t.classList.add('show');
  clearTimeout(toast._t); toast._t = setTimeout(() => t.classList.remove('show'), 2600);
}

/* ============ importing ============ */
async function fetchWithTimeout(url, ms = 14000) {
  const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), ms);
  try {
    const res = await fetch(url, { signal: ctl.signal });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    return await res.text();
  } finally { clearTimeout(t); }
}
async function fetchHtml(url) {
  const attempts = [url, ...settings().proxies.map(p => p.replace('{url}', encodeURIComponent(url)))];
  let last;
  for (const a of attempts) {
    try {
      const html = await fetchWithTimeout(a);
      if (html && html.length > 200 && /</.test(html)) return html;
    } catch (e) { last = e; }
  }
  throw last || new Error('Could not fetch page');
}

function extractFromHtml(html, url) {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  const meta = p => doc.querySelector(`meta[property="${p}"],meta[name="${p}"]`)?.content || '';
  const lds = [...doc.querySelectorAll('script[type="application/ld+json"]')].map(s => { try { return JSON.parse(s.textContent); } catch { return null; } }).filter(Boolean);
  const ld = L.draftFromLd(lds, url);
  const image = meta('og:image') || meta('twitter:image');
  if (ld && (ld.ingredients.length || ld.steps.length)) {
    const d = { ...blank(), ...ld };
    if (!d.image) d.image = image;
    if (!d.title) d.title = L.clean(meta('og:title') || doc.title);
    return d;
  }
  const title = L.clean(meta('og:title') || doc.title);
  const caption = L.cleanSocialCaption(meta('og:description') || meta('description'));
  let p = L.parseText(caption);
  if (p.ingredients.length < 2) {
    doc.querySelectorAll('script,style,nav,header,footer,noscript,svg').forEach(n => n.remove());
    doc.querySelectorAll('p,li,div,br,h1,h2,h3,h4,tr').forEach(n => n.append('\n'));
    const p2 = L.parseText((doc.body?.textContent || '').slice(0, 30000));
    if (p2.ingredients.length >= 2 && p2.steps.length >= 1) p = p2;
  }
  if (p.ingredients.length < 1 && p.steps.length < 1) {
    const e = new Error('no-recipe'); e.partial = { title, image, caption }; throw e;
  }
  const generic = /instagram|tiktok|facebook|youtube/i.test(title);
  return { ...blank(), title: (generic && p.title) || title || p.title, image, sourceUrl: url, sourceName: L.hostName(url), ingredients: p.ingredients, steps: p.steps, tags: p.tags, notes: p.notes };
}

function draftFromPayload(p) { // from the bookmarklet
  const url = p.u || '';
  if (p.j) { const ld = L.draftFromLd(p.j, url); if (ld && (ld.ingredients.length || ld.steps.length)) { const d = { ...blank(), ...ld }; d.image ||= p.i || ''; return d; } }
  const parsed = L.parseText(L.cleanSocialCaption(p.d || ''));
  return { ...blank(), title: L.clean(p.t || parsed.title), image: p.i || '', sourceUrl: url, sourceName: L.hostName(url), ingredients: parsed.ingredients, steps: parsed.steps, tags: parsed.tags, notes: parsed.ingredients.length || parsed.steps.length ? parsed.notes : L.cleanSocialCaption(p.d || '') };
}

async function importUrl(url) {
  url = url.trim();
  if (!/^https?:\/\//i.test(url)) { const m = url.match(/https?:\/\/\S+/); if (!m) { toast('Paste a full link starting with http'); return; } url = m[0]; }
  S.busy = true; S.pasteUrl = url; render();
  try {
    S.draft = extractFromHtml(await fetchHtml(url), url);
    S.busy = false; S.notice = '';
    location.hash = '#/edit/new';
  } catch (e) {
    S.busy = false; S.addTab = 'text'; S.pasteUrl = url;
    S.draft = null;
    if (e.partial) { S.draftImage = e.partial.image; S.pasteText = [e.partial.title, e.partial.caption].filter(Boolean).join('\n\n'); }
    S.notice = e.message === 'no-recipe'
      ? "I opened the page but couldn't find a structured recipe (common with Instagram/TikTok). I pulled what I could — paste the full caption below and I'll sort it out."
      : "That site blocked the free import proxies (common with NYT Cooking and other paywalled/bot-protected sites). Easiest fixes: use the “Save to Recibox” bookmarklet from Settings while on the recipe page, save the page as a PDF and use the PDF tab, or paste the recipe text here.";
    if (location.hash !== '#/add') location.hash = '#/add'; else render();
  }
}

function importText() {
  const raw = $('#pasteText').value, url = $('#pasteUrl').value.trim();
  if (!raw.trim()) return toast('Paste some text first');
  const p = L.parseText(raw);
  S.draft = { ...blank(), title: p.title, sourceUrl: url, sourceName: L.hostName(url), ingredients: p.ingredients, steps: p.steps, tags: p.tags, notes: p.notes };
  if (S.pasteUrl === url && S.draftImage) S.draft.image = S.draftImage;
  S.notice = ''; S.pasteText = '';
  location.hash = '#/edit/new';
}

/* ---- PDF import (pdf.js is bundled in /vendor and loaded on demand) ---- */
let pdfLoading;
function loadPdfJs() {
  if (window.pdfjsLib) return Promise.resolve(window.pdfjsLib);
  return (pdfLoading ||= new Promise((res, rej) => {
    const el = Object.assign(document.createElement('script'), { src: 'vendor/pdf.min.js' });
    el.onload = () => { pdfjsLib.GlobalWorkerOptions.workerSrc = 'vendor/pdf.worker.min.js'; res(pdfjsLib); };
    el.onerror = () => { pdfLoading = null; rej(new Error('Could not load the PDF reader (offline?)')); };
    document.head.appendChild(el);
  }));
}
async function pdfToText(file) {
  const lib = await loadPdfJs();
  const pdf = await lib.getDocument({ data: await file.arrayBuffer() }).promise;
  const out = [];
  for (let n = 1; n <= Math.min(pdf.numPages, 30); n++) {
    const content = await (await pdf.getPage(n)).getTextContent();
    let lastY = null, line = '';
    for (const it of content.items) {
      const y = Math.round(it.transform[5]);
      if (lastY !== null && Math.abs(y - lastY) > 2) { out.push(line.trim()); line = ''; }
      line += it.str + (it.hasEOL ? '\n' : '');
      lastY = y;
    }
    out.push(line.trim());
    out.push('');
  }
  return out.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}
async function importPdf(file) {
  if (!file) return;
  if (!/pdf$/i.test(file.type) && !/\.pdf$/i.test(file.name)) return toast('That is not a PDF');
  S.busy = true; S.notice = 'Reading ' + file.name + '…'; render();
  try {
    const text = await pdfToText(file);
    S.busy = false;
    if (text.replace(/\s/g, '').length < 40) {
      S.notice = 'No text found in that PDF. It may be a scan or photo — text recognition (OCR) is not supported yet.'; return render();
    }
    const p = L.parseText(text);
    S.draft = { ...blank(), title: p.title || file.name.replace(/\.pdf$/i, ''), ingredients: p.ingredients, steps: p.steps, tags: p.tags, notes: (p.ingredients.length || p.steps.length) ? p.notes : text.slice(0, 4000) };
    S.notice = ''; location.hash = '#/edit/new';
  } catch (e) {
    S.busy = false; S.notice = "Couldn't read that PDF: " + (e.message || e); render();
  }
}

/* ============ view helpers ============ */
const timeStr = r => L.fmtMin((r.prepMin || 0) + (r.cookMin || 0));
const imgStyle = r => r.image ? `style="background-image:url('${esc(r.image).replace(/'/g, '%27')}')"` : '';
const allTags = () => { const c = {}; S.recipes.forEach(r => (r.tags || []).forEach(t => c[t] = (c[t] || 0) + 1)); return Object.entries(c).sort((a, b) => b[1] - a[1]).map(e => e[0]); };
const scaleOf = r => (S.srv[r.id] && r.servings ? S.srv[r.id] / r.servings : 1);

function cardHtml(r) {
  return `<a class="card" href="#/recipe/${r.id}">
    <div class="img" ${imgStyle(r)}>${r.image ? '' : '🍽️'}</div>${r.favorite ? '<span class="heart">♥</span>' : ''}
    <div class="body"><h3>${esc(r.title || 'Untitled')}</h3><div class="meta">${esc([timeStr(r), r.sourceName].filter(Boolean).join(' · '))}</div></div></a>`;
}
function filtered() {
  const q = S.q.trim().toLowerCase();
  return S.recipes.filter(r => (!S.tag || (r.tags || []).includes(S.tag)) && (!S.favOnly || r.favorite) &&
    (!q || [r.title, r.notes, ...(r.tags || []), ...(r.ingredients || [])].join(' ').toLowerCase().includes(q)));
}
function gridHtml() {
  const rs = filtered();
  if (!S.recipes.length) return `<div class="empty"><div class="big">🥘</div><h2>Your recipe box is empty</h2><p>Save a recipe from any link, or paste a video caption.</p><a class="btn" href="#/add">Add your first recipe</a></div>`;
  if (!rs.length) return `<div class="empty"><div class="big">🔍</div><p>No recipes match.</p></div>`;
  return `<div class="grid">${rs.map(cardHtml).join('')}</div>`;
}

/* ============ views ============ */
function listView() {
  const tags = allTags();
  return `<div class="hdr"><h1>Recibox</h1><span class="muted small">${S.recipes.length} recipe${S.recipes.length === 1 ? '' : 's'}</span></div>
  <input id="q" type="search" placeholder="Search title, ingredient, tag…" value="${esc(S.q)}" autocomplete="off">
  <div class="chips gap" id="chips">
    <button class="chip ${S.favOnly ? 'on' : ''}" data-act="favFilter">♥ Favorites</button>
    ${tags.map(t => `<button class="chip ${S.tag === t ? 'on' : ''}" data-act="tag" data-v="${esc(t)}">${esc(t)}</button>`).join('')}
  </div><div id="grid">${gridHtml()}</div>`;
}

function detailView(id) {
  const r = byId(id);
  if (!r) return `<div class="empty"><p>Recipe not found.</p><a class="btn" href="#/">Back</a></div>`;
  const sc = scaleOf(r), srvNow = r.servings ? (S.srv[r.id] || r.servings) : 0;
  const ing = r.ingredients.map(i => {
    const t = L.scaleIngredient(i, sc);
    return /:\s*$/.test(i) ? `<div class="ing-h">${esc(t)}</div>` : `<label class="ing"><input type="checkbox"><span>${esc(t)}</span></label>`;
  }).join('');
  return `<div class="hdr noprint"><a class="btn ghost sm" href="#/">← Back</a>
    <div class="row"><button class="icon-btn" data-act="fav" data-id="${r.id}" aria-label="Favorite">${r.favorite ? '♥' : '♡'}</button>
    <button class="icon-btn" data-act="share" data-id="${r.id}" aria-label="Share">⤴</button></div></div>
  <div class="hero" ${imgStyle(r)}>${r.image ? '' : '🍽️'}</div>
  <h1>${esc(r.title || 'Untitled')}</h1>
  <div class="facts">
    ${r.prepMin ? `<div class="fact"><b>${L.fmtMin(r.prepMin)}</b><span>Prep</span></div>` : ''}
    ${r.cookMin ? `<div class="fact"><b>${L.fmtMin(r.cookMin)}</b><span>Cook</span></div>` : ''}
    ${r.servings ? `<div class="fact"><span>Servings</span><div class="stepper"><button data-act="srv" data-id="${r.id}" data-d="-1" aria-label="Fewer">−</button><b>${srvNow}</b><button data-act="srv" data-id="${r.id}" data-d="1" aria-label="More">+</button></div></div>` : ''}
  </div>
  <div>${(r.tags || []).map(t => `<span class="tag">${esc(t)}</span>`).join('')}</div>
  ${r.sourceUrl ? `<p class="small muted">Source: <a href="${esc(r.sourceUrl)}" target="_blank" rel="noopener noreferrer">${esc(r.sourceName || r.sourceUrl)}</a></p>` : ''}
  <div class="row wrap noprint">
    ${r.steps.length ? `<a class="btn" href="#/cook/${r.id}">👩‍🍳 Cook mode</a>` : ''}
    ${r.ingredients.length ? `<button class="btn soft" data-act="toGrocery" data-id="${r.id}">🛒 Add to grocery list</button>` : ''}
    <a class="btn ghost" href="#/edit/${r.id}">Edit</a>
  </div>
  <div class="cols">
    <section><h2>Ingredients</h2>${ing || '<p class="muted">None saved.</p>'}</section>
    <section><h2>Steps</h2>${r.steps.length ? `<ol class="steps">${r.steps.map(s => `<li><span>${esc(s)}</span></li>`).join('')}</ol>` : '<p class="muted">None saved.</p>'}</section>
  </div>
  ${r.notes ? `<section class="gap"><h2>Notes</h2><p class="notes">${esc(r.notes)}</p></section>` : ''}`;
}

function cookView(id) {
  const r = byId(id);
  if (!r || !r.steps.length) return `<div class="cook"><p>Nothing to cook.</p><a class="btn" href="#/">Back</a></div>`;
  S.cookI = Math.max(0, Math.min(S.cookI, r.steps.length - 1));
  const sc = scaleOf(r), last = S.cookI === r.steps.length - 1;
  return `<div class="cook">
    <div class="row"><a class="btn ghost sm" href="#/recipe/${r.id}">✕ Exit</a><b class="grow" style="text-align:center">${esc(r.title)}</b>
      <button class="btn soft sm" data-act="cookIng">Ingredients</button></div>
    <div class="progress"><i style="width:${((S.cookI + 1) / r.steps.length) * 100}%"></i></div>
    <div class="step"><div class="num">Step ${S.cookI + 1} of ${r.steps.length}</div>${esc(r.steps[S.cookI])}</div>
    <div class="bar"><button class="btn ghost" data-act="cookPrev" ${S.cookI ? '' : 'disabled'}>← Back</button>
      ${last ? `<a class="btn" href="#/recipe/${r.id}">Done ✓</a>` : `<button class="btn" data-act="cookNext">Next →</button>`}</div>
    <dialog id="cookIng" style="max-width:520px;width:92vw;border:0;border-radius:16px;background:var(--card);color:var(--ink)">
      <h2>Ingredients</h2>${r.ingredients.map(i => `<div class="ing">${esc(L.scaleIngredient(i, sc))}</div>`).join('')}
      <form method="dialog" class="gap"><button class="btn">Close</button></form></dialog></div>`;
}

function addView() {
  const t = S.addTab;
  return `<div class="hdr"><h1>Add recipe</h1></div>
  ${S.notice ? `<div class="notice">${esc(S.notice)}</div>` : ''}
  <div class="tabs"><button class="${t === 'link' ? 'on' : ''}" data-act="tab" data-v="link">Link</button>
    <button class="${t === 'text' ? 'on' : ''}" data-act="tab" data-v="text">Paste</button>
    <button class="${t === 'pdf' ? 'on' : ''}" data-act="tab" data-v="pdf">PDF</button>
    <button class="${t === 'manual' ? 'on' : ''}" data-act="tab" data-v="manual">Manual</button></div>
  ${t === 'link' ? `<div class="panel"><label class="f" style="margin-top:0">Recipe link</label>
      <input id="url" type="url" inputmode="url" placeholder="https://…" value="${esc(S.pasteUrl)}" ${S.busy ? 'disabled' : ''}>
      <p class="small muted">Works with almost any recipe blog. For Instagram / TikTok / YouTube, use <b>Paste text</b> with the caption (or the bookmarklet in Settings).</p>
      <button class="btn" data-act="importUrl" ${S.busy ? 'disabled' : ''}>${S.busy ? 'Fetching…' : 'Import recipe'}</button></div>` : ''}
  ${t === 'text' ? `<div class="panel"><label class="f" style="margin-top:0">Caption, notes or recipe text</label>
      <textarea id="pasteText" style="min-height:220px" placeholder="Paste a video caption or any recipe text. Lines under 'Ingredients' and 'Instructions' are detected automatically.">${esc(S.pasteText)}</textarea>
      <label class="f">Source link (optional)</label><input id="pasteUrl" type="url" value="${esc(S.pasteUrl)}" placeholder="https://instagram.com/…">
      <div class="gap"><button class="btn" data-act="importText">Parse &amp; review</button></div></div>` : ''}
  ${t === 'pdf' ? `<div class="panel"><label id="drop" class="drop" for="pdfFile"><b>${S.busy ? 'Reading PDF…' : 'Choose a PDF'}</b><span class="small muted">or drop it here · recipe cards, cookbook pages, “Print → Save as PDF” from any website</span></label>
      <input id="pdfFile" type="file" accept="application/pdf,.pdf" hidden ${S.busy ? 'disabled' : ''}>
      <p class="small muted">Read entirely on your device — the file is never uploaded. Scanned/photo PDFs aren't supported yet.</p></div>` : ''}
  ${t === 'manual' ? `<div class="panel"><p class="muted" style="margin-top:0">Start with an empty recipe.</p><button class="btn" data-act="manual">Create recipe</button></div>` : ''}`;
}

function editView(id) {
  const r = id === 'new' ? S.draft : { ...byId(id) };
  if (!r || (!r.id)) return `<div class="empty"><p>Nothing to edit.</p><a class="btn" href="#/add">Add a recipe</a></div>`;
  const isNew = id === 'new';
  return `<div class="hdr"><h1>${isNew ? 'Review recipe' : 'Edit recipe'}</h1></div>
  ${isNew ? '<div class="notice">Check the details, fix anything the importer got wrong, then save.</div>' : ''}
  <form id="rform" class="panel" data-id="${esc(id)}">
    <label class="f" style="margin-top:0">Title</label><input name="title" value="${esc(r.title)}" required>
    <label class="f">Image URL</label><input name="image" type="url" value="${esc(r.image)}">
    <label class="f">Source URL</label><input name="sourceUrl" type="url" value="${esc(r.sourceUrl)}">
    <div class="row"><div class="grow"><label class="f">Servings</label><input name="servings" type="number" min="0" value="${r.servings || ''}"></div>
      <div class="grow"><label class="f">Prep (min)</label><input name="prepMin" type="number" min="0" value="${r.prepMin || ''}"></div>
      <div class="grow"><label class="f">Cook (min)</label><input name="cookMin" type="number" min="0" value="${r.cookMin || ''}"></div></div>
    <label class="f">Tags (comma separated)</label><input name="tags" value="${esc((r.tags || []).join(', '))}">
    <label class="f">Ingredients (one per line; end a line with “:” for a section heading)</label><textarea name="ingredients" style="min-height:170px">${esc(r.ingredients.join('\n'))}</textarea>
    <label class="f">Steps (one per line)</label><textarea name="steps" style="min-height:170px">${esc(r.steps.join('\n'))}</textarea>
    <label class="f">Notes</label><textarea name="notes" style="min-height:80px">${esc(r.notes)}</textarea>
    <div class="row wrap gap"><button class="btn" type="submit">Save recipe</button>
      <a class="btn ghost" href="${isNew ? '#/add' : '#/recipe/' + esc(id)}">Cancel</a>
      ${isNew ? '' : `<span class="grow"></span><button type="button" class="btn danger" data-act="delete" data-id="${esc(id)}">Delete</button>`}</div>
  </form>`;
}

function groceryView() {
  const g = store.get('grocery', []);
  const open_ = g.filter(i => !i.done), done = g.filter(i => i.done);
  const item = i => `<div class="g-item ${i.done ? 'done' : ''}"><input type="checkbox" data-act="gToggle" data-id="${i.id}" ${i.done ? 'checked' : ''}><span class="grow">${esc(i.text)}</span><button class="icon-btn muted" data-act="gDel" data-id="${i.id}" aria-label="Remove">✕</button></div>`;
  return `<div class="hdr"><h1>Grocery list</h1><button class="btn ghost sm" data-act="gCopy" ${g.length ? '' : 'disabled'}>Copy</button></div>
  <form id="gform" class="row"><input id="gnew" placeholder="Add an item…" autocomplete="off"><button class="btn" type="submit">Add</button></form>
  <div class="panel gap">${g.length ? open_.map(item).join('') + done.map(item).join('') : '<div class="empty" style="padding:24px"><div class="big">🛒</div><p>Nothing here. Open a recipe and tap “Add to grocery list”.</p></div>'}</div>
  ${done.length ? `<div class="row gap"><button class="btn ghost sm" data-act="gClearDone">Clear checked</button><button class="btn danger sm" data-act="gClearAll">Clear all</button></div>` : ''}`;
}

function bookmarklet() {
  const app = location.origin + location.pathname;
  const js = `(function(){var d=document,r=[];d.querySelectorAll('script[type="application/ld+json"]').forEach(function(s){try{var j=JSON.parse(s.textContent);if(JSON.stringify(j).indexOf('"Recipe"')>-1)r.push(j)}catch(e){}});function m(p){var e=d.querySelector('meta[property="'+p+'"],meta[name="'+p+'"]');return e?e.content:''}var p={u:location.href,t:m('og:title')||d.title,i:m('og:image'),d:m('og:description')||m('description'),j:r.length?r:null};window.open(${JSON.stringify(app)}+'#import='+btoa(unescape(encodeURIComponent(JSON.stringify(p)))),'_blank')})()`;
  return 'javascript:' + encodeURIComponent(js);
}

function settingsView() {
  const s = settings();
  return `<div class="hdr"><h1>Settings</h1></div>
  <div class="panel"><h2>Backup &amp; restore</h2>
    <p class="small muted">Recipes live only in this browser. Export a backup regularly, and use it to move recipes to another device.</p>
    <div class="row wrap"><button class="btn" data-act="export">Export JSON</button>
    <label class="btn ghost" style="cursor:pointer">Import JSON<input type="file" id="importFile" accept="application/json" hidden></label></div></div>
  <div class="panel gap"><h2>Save from any page (desktop)</h2>
    <p class="small muted">Drag this to your bookmarks bar. On a recipe page, or an open Instagram post, click it to send the recipe/caption here.</p>
    <a class="bm" href="${esc(bookmarklet())}" onclick="return false">＋ Save to Recibox</a></div>
  <div class="panel gap"><h2>Import proxy</h2>
    <p class="small muted">Browsers block reading other websites directly, so link import goes through a CORS proxy. One URL per line; <code>{url}</code> is replaced by the page. For privacy and reliability you can deploy <code>worker/cors-proxy.js</code> to your own free Cloudflare Worker.</p>
    <textarea id="proxies" style="min-height:90px">${esc(s.proxies.join('\n'))}</textarea>
    <div class="row gap"><button class="btn" data-act="saveProxies">Save</button><button class="btn ghost" data-act="resetProxies">Reset</button></div></div>
  <div class="panel gap"><h2>Install on your phone</h2>
    <p class="small muted"><b>Android (Chrome):</b> menu → Install app. Then you can <b>Share → Recibox</b> from Instagram, TikTok or your browser to save a link. <br><b>iPhone (Safari):</b> Share → Add to Home Screen.</p></div>
  <div class="panel gap"><h2>Danger zone</h2><button class="btn danger" data-act="wipe">Delete all recipes</button></div>
  <p class="small muted gap" style="text-align:center">Recibox · private, offline-first, no account.</p>`;
}

/* ============ router ============ */
let wake = null;
async function setWake(on) {
  try {
    if (on && 'wakeLock' in navigator && !wake) wake = await navigator.wakeLock.request('screen');
    if (!on && wake) { await wake.release(); wake = null; }
  } catch { wake = null; }
}
function render() {
  const [p, id] = location.hash.replace(/^#\/?/, '').split('/');
  const part = decodeURIComponent(id || '');
  const views = { '': listView, add: addView, grocery: groceryView, settings: settingsView, recipe: detailView, edit: editView, cook: cookView };
  document.body.classList.toggle('cooking', p === 'cook');
  setWake(p === 'cook');
  const key = ['recipe', 'edit', 'cook'].includes(p) ? 'list' : (views[p] ? (p || 'list') : 'list');
  document.querySelectorAll('#nav a').forEach(a => a.classList.toggle('on', a.dataset.nav === (p === 'edit' && part === 'new' ? 'add' : key)));
  $('#app').innerHTML = (views[p] || listView)(part);
}
window.addEventListener('hashchange', () => { render(); window.scrollTo(0, 0); });

/* ============ events ============ */
const grocery = { get: () => store.get('grocery', []), set: v => store.set('grocery', v) };
const acts = {
  favFilter() { S.favOnly = !S.favOnly; render(); },
  tag(el) { S.tag = S.tag === el.dataset.v ? '' : el.dataset.v; render(); },
  tab(el) { S.addTab = el.dataset.v; S.notice = ''; render(); },
  importUrl() { importUrl($('#url').value); },
  importText,
  manual() { S.draft = blank(); location.hash = '#/edit/new'; },
  async fav(el) { const r = byId(el.dataset.id); r.favorite = !r.favorite; await save(r); render(); },
  srv(el) { const r = byId(el.dataset.id); const n = Math.max(1, (S.srv[r.id] || r.servings) + +el.dataset.d); S.srv[r.id] = n; render(); },
  async share(el) {
    const r = byId(el.dataset.id);
    const text = `${r.title}\n\nIngredients\n${r.ingredients.join('\n')}\n\nSteps\n${r.steps.map((s, i) => `${i + 1}. ${s}`).join('\n')}`;
    try { if (navigator.share) await navigator.share({ title: r.title, text }); else { await navigator.clipboard.writeText(text); toast('Recipe copied'); } } catch { /* cancelled */ }
  },
  toGrocery(el) {
    const r = byId(el.dataset.id), sc = scaleOf(r), g = grocery.get();
    const have = new Set(g.map(i => i.text.toLowerCase()));
    let n = 0;
    r.ingredients.filter(i => !/:\s*$/.test(i)).forEach(i => { const t = L.scaleIngredient(i, sc); if (!have.has(t.toLowerCase())) { g.push({ id: uid(), text: t, done: false, from: r.title }); n++; } });
    grocery.set(g); toast(n ? `Added ${n} item${n > 1 ? 's' : ''} to your list` : 'Already on your list');
  },
  async delete(el) { if (!confirm('Delete this recipe?')) return; await DB.del(el.dataset.id); S.recipes = S.recipes.filter(r => r.id !== el.dataset.id); location.hash = '#/'; toast('Deleted'); },
  cookNext() { S.cookI++; render(); }, cookPrev() { S.cookI--; render(); },
  cookIng() { $('#cookIng').showModal(); },
  gToggle(el) { const g = grocery.get(); const i = g.find(x => x.id === el.dataset.id); if (i) i.done = el.checked; grocery.set(g); render(); },
  gDel(el) { grocery.set(grocery.get().filter(x => x.id !== el.dataset.id)); render(); },
  gClearDone() { grocery.set(grocery.get().filter(x => !x.done)); render(); },
  gClearAll() { if (confirm('Clear the whole list?')) { grocery.set([]); render(); } },
  async gCopy() { await navigator.clipboard.writeText(grocery.get().filter(i => !i.done).map(i => '• ' + i.text).join('\n')); toast('Copied'); },
  export() {
    const blob = new Blob([JSON.stringify({ app: 'recibox', version: 1, exported: new Date().toISOString(), recipes: S.recipes }, null, 2)], { type: 'application/json' });
    const a = Object.assign(document.createElement('a'), { href: URL.createObjectURL(blob), download: `recibox-backup-${new Date().toISOString().slice(0, 10)}.json` });
    a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  },
  saveProxies() { store.set('settings', { ...store.get('settings', {}), proxies: lines($('#proxies').value) }); toast('Saved'); },
  resetProxies() { const s = store.get('settings', {}); delete s.proxies; store.set('settings', s); render(); toast('Reset'); },
  async wipe() { if (confirm('Delete ALL recipes? This cannot be undone. Export a backup first!')) { await DB.clear(); S.recipes = []; toast('All recipes deleted'); render(); } }
};

document.addEventListener('click', e => {
  const el = e.target.closest('[data-act]');
  if (!el || el.tagName === 'INPUT' && el.type === 'checkbox') return;
  e.preventDefault(); acts[el.dataset.act]?.(el);
});
document.addEventListener('change', e => {
  const el = e.target;
  if (el.dataset?.act === 'gToggle') return acts.gToggle(el);
  if (el.id === 'importFile') importBackup(el.files[0]);
  if (el.id === 'pdfFile') importPdf(el.files[0]);
});
document.addEventListener('input', e => {
  if (e.target.id === 'q') { S.q = e.target.value; $('#grid').innerHTML = gridHtml(); }
  if (e.target.id === 'pasteText') S.pasteText = e.target.value;
});
document.addEventListener('dragover', e => { if ($('#drop')) e.preventDefault(); });
document.addEventListener('drop', e => { if ($('#drop')) { e.preventDefault(); importPdf(e.dataTransfer.files[0]); } });
document.addEventListener('submit', async e => {
  e.preventDefault();
  if (e.target.id === 'gform') {
    const v = $('#gnew').value.trim(); if (!v) return;
    const g = grocery.get(); g.push({ id: uid(), text: v, done: false }); grocery.set(g); render(); $('#gnew').focus();
  }
  if (e.target.id === 'rform') {
    const f = new FormData(e.target), id = e.target.dataset.id;
    const r = id === 'new' ? S.draft : byId(id);
    Object.assign(r, {
      title: f.get('title').trim(), image: f.get('image').trim(), sourceUrl: f.get('sourceUrl').trim(),
      servings: +f.get('servings') || 0, prepMin: +f.get('prepMin') || 0, cookMin: +f.get('cookMin') || 0,
      tags: [...new Set(f.get('tags').split(',').map(t => t.trim().toLowerCase()).filter(Boolean))],
      ingredients: lines(f.get('ingredients')), steps: lines(f.get('steps')), notes: f.get('notes').trim()
    });
    r.sourceName = L.hostName(r.sourceUrl) || r.sourceName;
    await save(r); if (id === 'new') S.draft = null;
    toast('Saved'); location.hash = '#/recipe/' + r.id;
  }
});

async function importBackup(file) {
  if (!file) return;
  try {
    const data = JSON.parse(await file.text());
    const rs = (Array.isArray(data) ? data : data.recipes).filter(r => r && r.id && r.title !== undefined);
    await DB.putMany(rs);
    const m = new Map(S.recipes.map(r => [r.id, r])); rs.forEach(r => m.set(r.id, r));
    S.recipes = [...m.values()].sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
    toast(`Imported ${rs.length} recipe${rs.length === 1 ? '' : 's'}`); render();
  } catch { toast("That file isn't a valid backup"); }
}

/* ============ boot ============ */
async function boot() {
  try { S.recipes = (await DB.all()).sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0)); } catch { toast('Storage unavailable (private mode?)'); }
  if ('serviceWorker' in navigator && location.protocol !== 'file:') navigator.serviceWorker.register('sw.js').catch(() => { });

  // Entry points: bookmarklet (#import=…) and Android share target (?url=&text=&title=)
  const h = location.hash.match(/^#import=(.+)$/);
  const q = new URLSearchParams(location.search);
  if (h) {
    try {
      const p = JSON.parse(decodeURIComponent(escape(atob(h[1]))));
      S.draft = draftFromPayload(p);
      history.replaceState(null, '', location.pathname); location.hash = '#/edit/new'; return render();
    } catch { toast('Could not read the bookmarklet data'); }
  }
  if (q.has('url') || q.has('text')) {
    const shared = (q.get('url') || '') + ' ' + (q.get('text') || '');
    history.replaceState(null, '', location.pathname);
    const m = shared.match(/https?:\/\/\S+/);
    S.pasteText = (q.get('text') || '').replace(/https?:\/\/\S+/g, '').trim();
    if (m) { S.addTab = 'link'; location.hash = '#/add'; render(); return importUrl(m[0]); }
    S.addTab = 'text'; location.hash = '#/add';
  }
  render();
}
boot();
window.RB = { S, L, extractFromHtml, draftFromPayload }; // handy for debugging / tests
