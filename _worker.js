// Cloudflare Pages "advanced mode" worker. No build step, no secrets.
const HOST = 'https://get.harry.run';
const PROXY = 'https://dl.harry.run/download?url=';

// ---------- load url.txt (served as a static file from the same repo) ----------
let items = [], bySlug = {}, loadedAt = 0;
async function load(req, env) {
  if (Date.now() - loadedAt < 30000 && items.length) return; // cache 30s
  const r = await env.ASSETS.fetch(new URL('/url.txt', req.url));
  const raw = await r.text();
  items = raw.split('\n')
    .map(l => l.trim())
    .filter(l => l && !l.startsWith('#'))
    .map(l => {
      const [slug, name, category, url, desc] = l.split('|').map(s => s.trim());
      return { slug, name, category, url, desc: desc || '' };
    })
    .filter(i => i.slug && i.url);
  bySlug = Object.fromEntries(items.map(i => [i.slug, i]));
  loadedAt = Date.now();
}

const proxied = i => PROXY + encodeURIComponent(i.url);
const esc = s => s.replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const text = (b, status = 200) => new Response(b, { status, headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-cache' } });
const html = b => new Response(b, { headers: { 'content-type': 'text/html; charset=utf-8' } });
const json = o => new Response(JSON.stringify(o, null, 2), { headers: { 'content-type': 'application/json', 'access-control-allow-origin': '*' } });

export default {
  async fetch(req, env) {
    await load(req, env);
    const u = new URL(req.url);
    const path = u.pathname.replace(/\/+$/, '') || '/';
    const ua = req.headers.get('user-agent') || '';
    const cli = /curl|wget|httpie|fetch|powershell|python-requests|go-http/i.test(ua) ||
      !(req.headers.get('accept') || '').includes('text/html');

    if (path === '/') return cli ? text(menu()) : html(page());
    if (path === '/url.txt') return env.ASSETS.fetch(req);
    if (path === '/list') return text(menu());
    if (path === '/raw') return text(items.map(i => [i.slug, i.name, i.category, i.desc].join('|')).join('\n') + '\n');
    if (path === '/api.json') return json(items.map(i => ({ ...i, proxy: proxied(i), short: `${HOST}/${i.slug}` })));
    if (path === '/i') return text(installer());

    // /<slug> direct redirect | /p/<slug> or ?proxy=1 via dl.harry.run | /u/<slug> print real URL
    let slug = path.slice(1), mode = u.searchParams.has('proxy') ? 'proxy' : 'direct';
    if (slug.startsWith('p/')) { slug = slug.slice(2); mode = 'proxy'; }
    else if (slug.startsWith('u/')) { slug = slug.slice(2); mode = 'print'; }

    const it = bySlug[slug];
    if (!it) return text(`Unknown: "${slug}"\n\n${menu()}`, 404);
    if (mode === 'print') return text(it.url + '\n');
    return Response.redirect(mode === 'proxy' ? proxied(it) : it.url, 302);
  }
};

// ---------- curl / wget menu ----------
function menu() {
  const w = Math.max(...items.map(i => i.slug.length)) + 2;
  const rows = items.map(i => `  ${i.slug.padEnd(w)}${i.name} - ${i.desc}`).join('\n');
  return `get.harry.run - download links

${rows}

Download
  curl -LOJ ${HOST}/<name>            direct from the vendor
  curl -LOJ ${HOST}/p/<name>          through the dl.harry.run proxy
  wget --content-disposition ${HOST}/<name>

Interactive picker (numbered menu, asks about proxy)
  bash <(curl -fsSL ${HOST}/i)
  curl -fsSL ${HOST}/i | bash

Other: /list  /api.json  /url.txt  /u/<name> (print the real URL)
`;
}

// ---------- interactive shell script ----------
function installer() {
  return String.raw`#!/usr/bin/env bash
# get.harry.run interactive downloader
H="__HOST__"
if command -v curl >/dev/null 2>&1; then
  G(){ curl -fsSL "$1"; }
  D(){ curl -fLOJ --progress-bar "$1"; }
elif command -v wget >/dev/null 2>&1; then
  G(){ wget -qO- "$1"; }
  D(){ wget -q --show-progress --content-disposition "$1"; }
else echo "Need curl or wget."; exit 1; fi

B=$'\033[1m'; C=$'\033[36m'; Y=$'\033[33m'; X=$'\033[0m'
i=0
while IFS='|' read -r s n c d; do
  i=$((i+1)); S[$i]=$s; N[$i]=$n; K[$i]=$c; E[$i]=$d
done < <(G "$H/raw")
[ "$i" -eq 0 ] && { echo "Could not load the list."; exit 1; }

echo; echo "${B}get.harry.run${X}"
last=""
for n in $(seq 1 $i); do
  [ "${K[$n]}" != "$last" ] && { echo; echo "${Y}${K[$n]}${X}"; last="${K[$n]}"; }
  printf "  ${C}%2d${X}  %-22s %s\n" "$n" "${N[$n]}" "${E[$n]}"
done
echo
read -r -p "Pick number(s), e.g. 1 3 (q = quit): " pick </dev/tty
[ -z "$pick" ] || [ "$pick" = q ] && exit 0
read -r -p "Use dl.harry.run proxy? [y/N]: " px </dev/tty
suffix=""; case "$px" in y|Y) suffix="?proxy=1";; esac

for p in $pick; do
  if [ -n "${S[$p]}" ]; then
    echo; echo "${B}-> ${N[$p]}${X}"
    D "$H/${S[$p]}$suffix" || echo "   failed: ${N[$p]}"
  else echo "Skipping invalid choice: $p"; fi
done
echo; echo "Done. Files are in $(pwd)"
`.replace('__HOST__', HOST);
}

// ---------- WebUI ----------
function page() {
  const cats = [...new Set(items.map(i => i.category))];
  const cards = items.map(i => `
<article class="card" data-cat="${esc(i.category)}" data-q="${esc((i.name + ' ' + i.desc + ' ' + i.slug + ' ' + i.category).toLowerCase())}">
  <header><h2>${esc(i.name)}</h2><span class="tag">${esc(i.category)}</span></header>
  <p>${esc(i.desc)}</p>
  <div class="cmd"><code data-cmd>curl -LOJ ${HOST}/${esc(i.slug)}</code><button class="ghost" data-copy>Copy</button></div>
  <div class="row">
    <a class="btn" href="/${esc(i.slug)}">Download</a>
    <a class="btn alt" href="/p/${esc(i.slug)}">Download via proxy</a>
    <select data-tool aria-label="Command type" data-slug="${esc(i.slug)}"><option value="curl">curl</option><option value="wget">wget</option><option value="proxy">curl + proxy</option></select>
  </div>
</article>`).join('');

  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>get.harry.run</title><meta name="color-scheme" content="light dark">
<style>
:root{--bg:#eef3f8;--panel:#fff;--ink:#14213d;--mute:#5b6b85;--line:#d5deea;--acc:#2457f5;--accink:#fff;--term:#0f1b33;--termink:#bfe3ff}
@media (prefers-color-scheme:dark){:root{--bg:#0e1626;--panel:#16233b;--ink:#e8eefb;--mute:#93a4c3;--line:#26375a;--acc:#6f95ff;--accink:#0b1220;--term:#091120;--termink:#bfe3ff}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);font:16px/1.5 ui-sans-serif,system-ui,"Segoe UI",Roboto,sans-serif}
main{max-width:1040px;margin:0 auto;padding:48px 20px 80px}
h1{font-size:clamp(2.2rem,6vw,3.6rem);letter-spacing:-.03em;margin:0 0 8px;font-weight:800}
.lead{color:var(--mute);max-width:56ch;margin:0 0 28px}
.term{background:var(--term);color:var(--termink);border-radius:14px;padding:18px 20px;font:15px/1.6 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;display:flex;gap:14px;align-items:center;justify-content:space-between;flex-wrap:wrap}
.term b{color:#fff;font-weight:600}.term small{display:block;color:#7f9bc4;font-size:12.5px}
.term button{background:var(--acc);color:var(--accink);border:0;border-radius:8px;padding:8px 14px;font-weight:700;cursor:pointer}
.bar{display:flex;gap:10px;flex-wrap:wrap;margin:30px 0 18px;align-items:center}
input[type=search]{flex:1 1 220px;padding:11px 14px;border-radius:10px;border:1px solid var(--line);background:var(--panel);color:var(--ink);font:inherit}
.chip{border:1px solid var(--line);background:var(--panel);color:var(--ink);padding:8px 14px;border-radius:99px;cursor:pointer;font:inherit}
.chip[aria-pressed=true]{background:var(--acc);color:var(--accink);border-color:var(--acc)}
.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(310px,1fr));gap:16px}
.card{background:var(--panel);border:1px solid var(--line);border-radius:14px;padding:18px;display:flex;flex-direction:column;gap:12px}
.card[hidden]{display:none}
.card header{display:flex;justify-content:space-between;gap:10px;align-items:start}
.card h2{font-size:1.1rem;margin:0}.card p{margin:0;color:var(--mute);font-size:.95rem;flex:1}
.tag{font-size:.78rem;color:var(--mute);border:1px solid var(--line);border-radius:6px;padding:1px 8px;white-space:nowrap}
.cmd{display:flex;gap:8px;align-items:center;background:var(--term);border-radius:8px;padding:8px 10px}
.cmd code{color:var(--termink);font:13px ui-monospace,Menlo,Consolas,monospace;overflow-x:auto;white-space:nowrap;flex:1}
.ghost{background:transparent;color:var(--termink);border:1px solid #3a5280;border-radius:6px;padding:3px 10px;cursor:pointer;font:inherit;font-size:.85rem}
.row{display:flex;gap:8px;flex-wrap:wrap}
.btn{background:var(--acc);color:var(--accink);text-decoration:none;font-weight:700;padding:8px 14px;border-radius:8px;font-size:.92rem}
.btn.alt{background:transparent;color:var(--acc);border:1px solid var(--acc)}
select{margin-left:auto;background:var(--panel);color:var(--ink);border:1px solid var(--line);border-radius:8px;padding:6px 8px;font:inherit;font-size:.88rem}
:focus-visible{outline:3px solid var(--acc);outline-offset:2px}
.empty{display:none;color:var(--mute);padding:30px 0}footer{margin-top:40px;color:var(--mute);font-size:.9rem}footer a{color:var(--acc)}
</style></head><body><main>
<h1>get.harry.run</h1>
<p class="lead">Short links for the installers I use. Click to download, copy a command for a terminal, or run the interactive picker.</p>
<div class="term"><div><b>bash &lt;(curl -fsSL ${HOST}/i)</b><small>Interactive picker: numbered menu, optional proxy. Works with wget too.</small></div><button data-copy-text="bash <(curl -fsSL ${HOST}/i)">Copy</button></div>
<div class="bar"><input type="search" id="q" placeholder="Search apps" aria-label="Search apps">
<button class="chip" aria-pressed="true" data-c="">All</button>${cats.map(c => `<button class="chip" aria-pressed="false" data-c="${esc(c)}">${esc(c)}</button>`).join('')}</div>
<section class="grid" id="g">${cards}</section><p class="empty" id="e">Nothing matches. Clear the search or pick All.</p>
<footer>${items.length} links. <a href="/api.json">JSON</a> · <a href="/list">Plain text</a></footer></main>
<script>
const H=${JSON.stringify(HOST)};
let cat='';const q=document.getElementById('q'),cards=[...document.querySelectorAll('.card')];
function f(){let n=0;cards.forEach(c=>{const ok=(!cat||c.dataset.cat===cat)&&c.dataset.q.includes(q.value.toLowerCase());c.hidden=!ok;if(ok)n++});document.getElementById('e').style.display=n?'none':'block'}
q.oninput=f;
document.querySelectorAll('.chip').forEach(b=>b.onclick=()=>{cat=b.dataset.c;document.querySelectorAll('.chip').forEach(x=>x.setAttribute('aria-pressed',x===b));f()});
async function copy(t,b){try{await navigator.clipboard.writeText(t)}catch(e){}const o=b.textContent;b.textContent='Copied';setTimeout(()=>b.textContent=o,1200)}
document.querySelectorAll('[data-copy-text]').forEach(b=>b.onclick=()=>copy(b.dataset.copyText,b));
cards.forEach(c=>{const code=c.querySelector('[data-cmd]'),sel=c.querySelector('select'),s=sel.dataset.slug;
sel.onchange=()=>{code.textContent={curl:'curl -LOJ '+H+'/'+s,wget:'wget --content-disposition '+H+'/'+s,proxy:'curl -LOJ '+H+'/p/'+s}[sel.value]};
c.querySelector('[data-copy]').onclick=e=>copy(code.textContent,e.target)});
</script></body></html>`;
}
