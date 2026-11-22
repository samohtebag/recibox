// Pure helpers (no DOM). Loaded as a plain script in the browser and require()d by the tests in Node.
(function (root) {
  'use strict';

  /* ---------- text cleanup ---------- */
  const NAMED = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', deg: '°', frac12: '½', frac14: '¼', frac34: '¾', ndash: '–', mdash: '—', rsquo: '’', lsquo: '‘', ldquo: '“', rdquo: '”', hellip: '…', eacute: 'é' };
  function decodeEntities(s) {
    const once = t => String(t).replace(/&(#x[0-9a-f]+|#\d+|[a-z0-9]+);/gi, (m, e) => {
      if (e[0] === '#') {
        const code = e[1].toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
        try { return String.fromCodePoint(code); } catch { return m; }
      }
      return NAMED[e.toLowerCase()] ?? m;
    });
    return once(once(s)); // some sites double-encode
  }
  function stripHtml(s) {
    return decodeEntities(String(s).replace(/<\s*br\s*\/?>|<\/(p|li|div|h\d)>/gi, '\n').replace(/<[^>]+>/g, ''));
  }
  const clean = s => stripHtml(s).replace(/[ \t ]+/g, ' ').trim();

  /* ---------- time ---------- */
  function durationToMin(d) {
    if (d == null || d === '') return 0;
    if (typeof d === 'number') return Math.round(d);
    const m = String(d).match(/^P(?:(\d+)D)?T?(?:(\d+)H)?(?:(\d+)M)?/i);
    if (m && (m[1] || m[2] || m[3])) return (+m[1] || 0) * 1440 + (+m[2] || 0) * 60 + (+m[3] || 0);
    const n = String(d).match(/(\d+)\s*(h|hr|hour)/i), k = String(d).match(/(\d+)\s*(m|min)/i);
    if (n || k) return (n ? +n[1] * 60 : 0) + (k ? +k[1] : 0);
    const plain = parseInt(d, 10);
    return Number.isFinite(plain) ? plain : 0;
  }
  function fmtMin(m) {
    m = Math.round(+m || 0);
    if (!m) return '';
    if (m < 60) return m + ' min';
    const h = Math.floor(m / 60), r = m % 60;
    return h + ' hr' + (r ? ' ' + r + ' min' : '');
  }

  /* ---------- quantity scaling ---------- */
  const UF = { '¼': .25, '½': .5, '¾': .75, '⅓': 1 / 3, '⅔': 2 / 3, '⅛': .125, '⅜': .375, '⅝': .625, '⅞': .875 };
  const UFC = '¼½¾⅓⅔⅛⅜⅝⅞';
  const NUM = `(?:\\d+\\s+\\d+\\/\\d+|\\d+\\s*[${UFC}]|\\d+\\/\\d+|\\d+(?:\\.\\d+)?|[${UFC}])`;
  const QRE = new RegExp(`^(\\s*(?:[-•*]\\s*)?)(${NUM})(?:(\\s*(?:-|–|—|to)\\s*)(${NUM}))?(?![\\d/])`);

  function parseNum(s) {
    s = s.trim(); let m;
    if ((m = s.match(/^(\d+)\s+(\d+)\/(\d+)$/))) return +m[1] + m[2] / m[3];
    if ((m = s.match(new RegExp(`^(\\d+)\\s*([${UFC}])$`)))) return +m[1] + UF[m[2]];
    if ((m = s.match(/^(\d+)\/(\d+)$/))) return m[1] / m[2];
    if (UF[s]) return UF[s];
    return parseFloat(s);
  }
  const FR = [[0, ''], [1 / 8, '⅛'], [1 / 4, '¼'], [1 / 3, '⅓'], [3 / 8, '⅜'], [1 / 2, '½'], [5 / 8, '⅝'], [2 / 3, '⅔'], [3 / 4, '¾'], [7 / 8, '⅞'], [1, '']];
  function fmtNum(n) {
    if (n >= 10) return String(Math.round(n * 10) / 10).replace(/\.0$/, '');
    let w = Math.floor(n + 1e-9);
    const f = n - w;
    let best = FR[0];
    for (const o of FR) if (Math.abs(o[0] - f) < Math.abs(best[0] - f)) best = o;
    if (best[0] === 1) { w += 1; best = FR[0]; }
    if (!w && !best[1]) return '⅛';
    return (w ? w : '') + (w && best[1] ? ' ' : '') + best[1];
  }
  function scaleIngredient(line, factor) {
    if (!factor || factor === 1) return line;
    const m = QRE.exec(line);
    if (!m) return line;
    const a = parseNum(m[2]);
    if (!Number.isFinite(a)) return line;
    const b = m[4] ? parseNum(m[4]) : null;
    return m[1] + fmtNum(a * factor) + (b != null ? m[3] + fmtNum(b * factor) : '') + line.slice(m[0].length);
  }

  /* ---------- free text (captions, pasted recipes) ---------- */
  const ING_H = /^(ingredients?|what you(?:'|’)?ll need|you(?:'|’)?ll need|shopping list)\s*:?\s*$/i;
  const STEP_H = /^(instructions?|directions?|method|steps?|preparation|procedure|how to (?:make|cook)(?: it)?)\s*:?\s*$/i;
  const STEP_PREFIX = /^(?:step\s*\d+\s*[:.\-)]?|\d+\s*[.):])\s*/i;
  const QTY_START = /^(?:[-•*▪●◦✔✅☑️\s]*)(?:\d|[¼½¾⅓⅔⅛⅜⅝⅞]|(?:a|an|one|two|three|half|pinch|dash|handful|splash|some|few)\s)/i;
  const bare = l => l.replace(/^[^\p{L}\p{N}]+/u, '');
  const unbullet = l => l.replace(/^[\s\-•*▪●◦✔✅☑️·]+/u, '').trim();

  function parseText(raw) {
    const tags = [];
    const lines = String(raw || '').replace(/\r/g, '').split('\n').map(l =>
      l.replace(/#([\p{L}\p{N}_]+)/gu, (m, t) => { if (tags.length < 6) tags.push(t.toLowerCase()); return ''; }).trim());
    const pre = [], ing = [], steps = [];
    let mode = null, sawHeader = false;

    for (const l of lines) {
      if (!l) continue;
      const b = bare(l);
      if (ING_H.test(b)) { mode = 'ing'; sawHeader = true; continue; }
      if (STEP_H.test(b)) { mode = 'steps'; sawHeader = true; continue; }
      if (mode === 'ing') ing.push(unbullet(l));
      else if (mode === 'steps') steps.push(l.replace(STEP_PREFIX, '').replace(/^[\s\-•*▪●◦]+/u, '').trim());
      else pre.push(l);
    }

    if (!sawHeader) {
      // Heuristic: quantity-looking short lines are ingredients, numbered / longer lines after them are steps.
      pre.length = 0;
      let seenIng = false;
      for (const l of lines) {
        if (!l) continue;
        const numbered = STEP_PREFIX.test(l) && /^(step|\d+\s*[.):])/i.test(l);
        if (!numbered && QTY_START.test(l) && l.length < 90) { ing.push(unbullet(l)); seenIng = true; }
        else if (numbered) steps.push(l.replace(STEP_PREFIX, '').trim());
        else if (seenIng && l.length >= 15) steps.push(l);
        else pre.push(l);
      }
    }

    let title = '';
    if (pre.length) {
      title = bare(pre[0]).replace(/[\p{Extended_Pictographic}️]+/gu, '').replace(/\s+/g, ' ').trim();
      if (title.length > 80) title = title.split(/[.!?]/)[0].slice(0, 80).trim();
    }
    return { title, ingredients: ing.filter(Boolean), steps: steps.filter(Boolean), notes: pre.slice(1).join('\n').trim(), tags };
  }

  /* ---------- schema.org Recipe (JSON-LD) ---------- */
  const arr = x => (x == null ? [] : Array.isArray(x) ? x : [x]);
  const isType = (n, t) => arr(n && n['@type']).some(x => String(x).toLowerCase() === t.toLowerCase());

  function findRecipe(node, depth = 0) {
    if (!node || depth > 6) return null;
    if (Array.isArray(node)) { for (const n of node) { const r = findRecipe(n, depth + 1); if (r) return r; } return null; }
    if (typeof node !== 'object') return null;
    if (isType(node, 'Recipe')) return node;
    for (const k of ['@graph', 'mainEntity', 'mainEntityOfPage', 'itemListElement', 'item']) {
      const r = findRecipe(node[k], depth + 1); if (r) return r;
    }
    return null;
  }

  function instrToSteps(x) {
    if (x == null) return [];
    if (typeof x === 'string') {
      return stripHtml(x).split(/\n+/).map(s => s.replace(/^\s*(?:step\s*)?\d+\s*[.):]\s*/i, '').trim()).filter(Boolean);
    }
    if (Array.isArray(x)) return x.flatMap(instrToSteps);
    if (typeof x === 'object') {
      if (x.itemListElement) return instrToSteps(x.itemListElement);
      return instrToSteps(x.text || x.name || '');
    }
    return [];
  }

  function imageOf(img, base) {
    let u = Array.isArray(img) ? img[0] : img;
    if (u && typeof u === 'object') u = u.url || u.contentUrl || '';
    if (!u) return '';
    try { return new URL(u, base || undefined).href; } catch { return String(u); }
  }

  function hostName(url) { try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return ''; } }

  function draftFromLd(ld, url) {
    const r = findRecipe(ld);
    if (!r) return null;
    const yieldNum = parseInt(String(arr(r.recipeYield)[0] ?? '').match(/\d+/)?.[0] || '0', 10);
    const kw = typeof r.keywords === 'string' ? r.keywords.split(/,\s*/) : arr(r.keywords);
    const tags = [...new Set([...arr(r.recipeCategory), ...arr(r.recipeCuisine), ...kw]
      .map(t => clean(t).toLowerCase()).filter(t => t && t.length < 28))].slice(0, 8);
    const ingredients = arr(r.recipeIngredient || r.ingredients).map(clean).filter(Boolean);
    const total = durationToMin(r.totalTime), prep = durationToMin(r.prepTime), cook = durationToMin(r.cookTime);
    return {
      title: clean(r.name || ''),
      image: imageOf(r.image, url),
      sourceUrl: url || '',
      sourceName: hostName(url),
      servings: yieldNum || 0,
      prepMin: prep, cookMin: cook || (total && !prep ? total : 0),
      ingredients,
      steps: instrToSteps(r.recipeInstructions),
      tags,
      notes: clean(r.description || '').slice(0, 600)
    };
  }

  // Instagram/TikTok og:description looks like: `12K likes, 80 comments - user on March 3, 2024: "caption..."`
  function cleanSocialCaption(s) {
    s = String(s || '');
    const m = s.match(/^[^:]{0,160}?(?: on [A-Z][a-z]+ \d{1,2}, \d{4}|\bon Instagram)\s*:\s*["“]?([\s\S]*?)["”]?\.?\s*$/);
    return (m ? m[1] : s).trim();
  }

  const api = { decodeEntities, stripHtml, clean, durationToMin, fmtMin, parseNum, fmtNum, scaleIngredient, parseText, findRecipe, draftFromLd, cleanSocialCaption, hostName };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.RB_LIB = api;
})(typeof self !== 'undefined' ? self : this);
