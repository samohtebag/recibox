// Run: node tests/e2e.js   (needs playwright; serves the app and mocks the CORS proxy)
const { chromium } = require('playwright');
const http = require('http'), fs = require('fs'), path = require('path');
const root = path.join(__dirname, '..'), fx = process.env.FIXTURES || path.join(__dirname, 'fixtures');
const mime = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.webmanifest': 'application/manifest+json' };
const srv = http.createServer((q, r) => { const f = path.join(root, q.url.split('?')[0] === '/' ? 'index.html' : q.url.split('?')[0]); fs.readFile(f, (e, d) => { if (e) { r.writeHead(404); r.end(); } else { r.writeHead(200, { 'content-type': mime[path.extname(f)] || 'text/plain' }); r.end(d); } }); });
const ok = (c, m) => { if (!c) { console.error('FAIL', m); process.exitCode = 1; } else console.log('ok  ', m); };
(async () => {
  await new Promise(r => srv.listen(0, r)); const base = `http://localhost:${srv.address().port}/`;
  const b = await chromium.launch(); const ctx = await b.newContext({ viewport: { width: 390, height: 800 }, deviceScaleFactor: 2 }); const pg = await ctx.newPage();
  const errs = []; pg.on('pageerror', e => errs.push(e.message));
  await ctx.route(/corsproxy\.io|allorigins/, route => {
    const u = decodeURIComponent(route.request().url().split(/url=/)[1]);
    const file = u.includes('insta') ? 'insta.html' : u.includes('recipe') ? 'recipe.html' : null;
    file ? route.fulfill({ status: 200, contentType: 'text/html', body: fs.readFileSync(path.join(fx, file)) }) : route.fulfill({ status: 500, body: 'x' });
  });
  await pg.route('https://example.com/**', r => r.fulfill({ status: 404, body: '' })); // direct fetches fail like CORS would
  await pg.goto(base); await pg.waitForSelector('.empty');
  ok(true, 'empty state renders');

  // link import
  await pg.click('a[href="#/add"]'); await pg.fill('#url', 'https://example.com/recipe'); await pg.click('[data-act=importUrl]');
  await pg.waitForSelector('#rform'); ok(await pg.inputValue('[name=title]') === 'Best Chili', 'JSON-LD import fills title');
  ok((await pg.inputValue('[name=ingredients]')).split('\n').length === 3, 'ingredients parsed');
  await pg.screenshot({ path: '/tmp/shots/review.png' });
  await pg.click('button[type=submit]'); await pg.waitForSelector('.hero');

  // scaling
  ok(await pg.locator('.ing').first().innerText() === '1 lb beef', 'ingredient shown');
  await pg.click('[data-act=srv][data-d="1"]'); await pg.click('[data-act=srv][data-d="1"]'); // 4 -> 6
  ok((await pg.locator('.ing').nth(2).innerText()).startsWith('2 ¼ tsp'), 'scales 1 1/2 tsp ×1.5 = 2 ¼ (got ' + await pg.locator('.ing').nth(2).innerText() + ')');
  await pg.screenshot({ path: '/tmp/shots/detail.png', fullPage: true });
  await pg.click('[data-act=toGrocery]');
  await pg.click('a[href="#/grocery"]'); await pg.waitForSelector('.g-item'); ok(await pg.locator('.g-item').count() === 3, 'grocery has 3 items, got '+await pg.locator('.g-item').count()+' '+await pg.evaluate(()=>localStorage.getItem('recibox.grocery')));
  await pg.screenshot({ path: '/tmp/shots/grocery.png' });
  await pg.locator('.g-item input').first().click(); ok(await pg.locator('.g-item.done').count() === 1, 'check off item');

  // instagram: structured parse fails -> falls back to caption in og:description
  await pg.click('a[href="#/add"]'); await pg.fill('#url', 'https://example.com/insta'); await pg.click('[data-act=importUrl]');
  await pg.waitForSelector('#rform'); ok(await pg.inputValue('[name=title]') === 'Garlic noodles', 'caption title from first line');
  ok((await pg.inputValue('[name=steps]')).includes('Toss in garlic butter'), 'caption steps parsed');
  await pg.click('button[type=submit]'); await pg.waitForSelector('.hero');

  // failing url -> paste tab with notice
  await pg.click('a[href="#/add"]'); await pg.fill('#url', 'https://example.com/nothing'); await pg.click('[data-act=importUrl]');
  await pg.waitForSelector('.notice'); ok(await pg.locator('#pasteText').count() === 1, 'failed import falls back to paste tab');
  await pg.fill('#pasteText', 'Toast\nIngredients:\n2 slices bread\nSteps:\nToast the bread.'); await pg.click('[data-act=importText]');
  await pg.waitForSelector('#rform'); await pg.click('button[type=submit]'); await pg.waitForSelector('.hero');

  // list/search/fav
  await pg.click('a[href="#/"]'); await pg.waitForSelector('.card'); ok(await pg.locator('.card').count() === 3, '3 recipes in list');
  await pg.fill('#q', 'beans'); ok(await pg.locator('.card').count() === 1, 'search by ingredient');
  await pg.screenshot({ path: '/tmp/shots/list.png' });

  // cook mode
  await pg.fill('#q', ''); await pg.locator('.card h3', { hasText: 'Best Chili' }).click(); await pg.click('a[href^="#/cook"]');
  ok((await pg.locator('.cook .step').innerText()).includes('Brown the beef'), 'cook mode step 1');
  await pg.click('[data-act=cookNext]'); ok((await pg.locator('.cook .step').innerText()).includes('simmer'), 'cook mode step 2');
  await pg.screenshot({ path: '/tmp/shots/cook.png' });

  // bookmarklet payload
  const payload = Buffer.from(unescape(encodeURIComponent(JSON.stringify({ u: 'https://x.com/a', t: 'T', i: '', d: 'Bookmarklet dish\nIngredients:\n1 egg\nSteps:\nFry.', j: null })))).toString('base64');
  await pg.goto(base + '#import=' + payload); await pg.reload(); await pg.waitForSelector('#rform');
  ok((await pg.inputValue('[name=ingredients]')) === '1 egg', 'bookmarklet import');
  // share target
  await pg.goto(base + '?url=' + encodeURIComponent('https://example.com/recipe') + '&title=x'); await pg.waitForSelector('#rform');
  ok(await pg.inputValue('[name=title]') === 'Best Chili', 'share target import');

  // persistence + export
  await pg.goto(base); await pg.waitForSelector('.card'); ok(await pg.locator('.card').count() === 3, 'persisted after reload');
  await pg.click('a[href="#/settings"]'); await pg.screenshot({ path: '/tmp/shots/settings.png', fullPage: true });
  ok(errs.length === 0, 'no page errors ' + errs.join('|'));
  await b.close(); srv.close();
})().catch(e => { console.error(e); process.exit(1); });
