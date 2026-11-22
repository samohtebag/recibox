// Optional: your own tiny CORS proxy on Cloudflare Workers (free tier, no card needed).
//   1. dash.cloudflare.com → Workers & Pages → Create → "Hello World" worker → paste this → Deploy
//   2. In Recibox → Settings → Import proxy, add a line:  https://YOUR-WORKER.workers.dev/?url={url}
// It only does GET, only http(s), and only returns HTML/text/JSON — it is not an open relay for anything else.
export default {
  async fetch(request) {
    const cors = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET, OPTIONS' };
    if (request.method === 'OPTIONS') return new Response(null, { headers: cors });
    const target = new URL(request.url).searchParams.get('url');
    if (!target || !/^https?:\/\//i.test(target)) return new Response('Missing or invalid ?url=', { status: 400, headers: cors });
    try {
      const res = await fetch(target, {
        redirect: 'follow',
        headers: {
          'User-Agent': 'Mozilla/5.0 (compatible; Recibox/1.0; +personal-recipe-box)',
          'Accept': 'text/html,application/xhtml+xml'
        }
      });
      const type = res.headers.get('content-type') || '';
      if (!/text\/|json|xml/i.test(type)) return new Response('Unsupported content type', { status: 415, headers: cors });
      return new Response(res.body, { status: res.status, headers: { ...cors, 'Content-Type': type } });
    } catch (e) {
      return new Response('Upstream fetch failed', { status: 502, headers: cors });
    }
  }
};
