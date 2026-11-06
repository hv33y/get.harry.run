// Cloudflare Pages "advanced mode" worker. No build step, no secrets.
const HOST = 'https://get.harry.run';
const PROXY = 'https://dl.harry.run/download?url='; // proxy picks the real file name + extension

// ---------- load url.txt (served as a static file from the same repo) ----------
let items = [], bySlug = {}, byNum = {}, loadedAt = 0;
async function load(req, env) {
  if (Date.now() - loadedAt < 30000 && items.length) return; // cache 30s
  const raw = await (await env.ASSETS.fetch(new URL('/url.txt', req.url))).text();
  items = raw.split('\n')
    .map(l => l.trim())
    .filter(l => l && !l.startsWith('#'))
    .map(l => {
      const [num, slug, name, url] = l.split('|').map(s => s.trim());
      return { num, slug, name, url };
    })
    .filter(i => i.num && i.slug && i.url)
    .sort((a, b) => Number(a.num) - Number(b.num));
  bySlug = Object.fromEntries(items.map(i => [i.slug, i]));
  byNum = Object.fromEntries(items.map(i => [i.num, i]));
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
    if (path === '/raw') return text(items.map(i => [i.num, i.slug, i.name].join('|')).join('\n') + '\n');
    if (path === '/api.json') return json(items.map(i => ({ ...i, proxy: proxied(i), short: `${HOST}/${i.slug}` })));
    if (path === '/i') return text(shellScript());
    if (path === '/w') return text(powershellScript());

    // /<slug or number> -> via dl.harry.run proxy (default) | /d/<slug> -> straight to vendor | /u/<slug> -> print real URL
    let key = path.slice(1), mode = u.searchParams.has('direct') ? 'direct' : 'proxy';
    if (key.startsWith('d/')) { key = key.slice(2); mode = 'direct'; }
    else if (key.startsWith('u/')) { key = key.slice(2); mode = 'print'; }

    const it = bySlug[key] || byNum[key];
    if (!it) return text(`Unknown: "${key}"\n\n${menu()}`, 404);
    if (mode === 'print') return text(it.url + '\n');
    return Response.redirect(mode === 'direct' ? it.url : proxied(it), 302);
  }
};

// ---------- curl / wget menu ----------
function menu() {
  const w = Math.max(...items.map(i => i.slug.length)) + 2;
  const rows = items.map(i => `  ${i.num.padStart(2)}  ${i.slug.padEnd(w)}${i.name}`).join('\n');
  return `get.harry.run - download links

${rows}

Download (file name and extension come from the proxy)
  curl -LOJ ${HOST}/<name or number>
  wget --content-disposition ${HOST}/<name or number>
  curl -LOJ ${HOST}/d/<name>          skip the proxy, go straight to the vendor

Pick several from a numbered menu
  Linux/macOS   bash <(curl -fsSL ${HOST}/i)
  Windows       irm ${HOST}/w | iex

Other: /list  /api.json  /url.txt  /u/<name> (print the real URL)
`;
}

// ---------- interactive: Linux / macOS ----------
function shellScript() {
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

B=$'\033[1m'; C=$'\033[36m'; X=$'\033[0m'
ORDER=""
while IFS='|' read -r num s n; do
  [ -z "$num" ] && continue
  ORDER="$ORDER $num"; S[$num]=$s; N[$num]=$n
done < <(G "$H/raw")
[ -z "$ORDER" ] && { echo "Could not load the list."; exit 1; }

echo; echo "@{B}get.harry.run@{X}"; echo
for k in $ORDER; do printf "  @{C}%2s@{X}  %s\n" "$k" "@{N[$k]}"; done
echo
read -r -p "Pick number(s), e.g. 1 3 5 (q = quit): " pick </dev/tty
pick=@{pick//,/ }
[ -z "$pick" ] || [ "$pick" = q ] && exit 0

for p in $pick; do
  if [ -n "@{S[$p]}" ]; then
    echo; echo "@{B}-> @{N[$p]}@{X}"
    D "$H/@{S[$p]}" || echo "   failed: @{N[$p]}"
  else echo "Skipping invalid choice: $p"; fi
done
echo; echo "Done. Files are in $(pwd)"
`.replace('__HOST__', HOST).replaceAll('@{', '$' + '{');
}

// ---------- interactive: Windows PowerShell (irm get.harry.run/w | iex) ----------
function powershellScript() {
  return String.raw`# get.harry.run interactive downloader (Windows)
$H = "__HOST__"
if (-not (Get-Command curl.exe -ErrorAction SilentlyContinue)) { Write-Host "curl.exe not found (it ships with Windows 10 and 11)." -ForegroundColor Red; return }
$items = [ordered]@{}
foreach ($r in ((Invoke-RestMethod "$H/raw") -split "\r?\n")) {
  if ($r.Trim()) { $p = $r.Split('|'); $items[$p[0]] = $p }
}
Write-Host ""; Write-Host "get.harry.run" -ForegroundColor Cyan; Write-Host ""
foreach ($k in $items.Keys) { Write-Host ("  {0,2}  {1}" -f $k, $items[$k][2]) }
Write-Host ""
$pick = Read-Host "Pick number(s), e.g. 1 3 5 (q = quit)"
if (-not $pick -or $pick -eq 'q') { return }
foreach ($n in ($pick -split "[\s,]+" | Where-Object { $_ })) {
  if (-not $items.Contains($n)) { Write-Host "Skipping invalid choice: $n" -ForegroundColor Yellow; continue }
  Write-Host ""; Write-Host ("-> " + $items[$n][2]) -ForegroundColor Cyan
  curl.exe -fLOJ --progress-bar ("$H/" + $items[$n][1])
  if ($LASTEXITCODE -ne 0) { Write-Host ("   failed: " + $items[$n][2]) -ForegroundColor Red }
}
Write-Host ""; Write-Host ("Done. Files are in " + (Get-Location)) -ForegroundColor Green
`.replace('__HOST__', HOST);
}

// ---------- WebUI ----------
function page() {
  const cards = items.map(i => `
<article class="card" data-q="${esc((i.name + ' ' + i.slug + ' ' + i.num).toLowerCase())}">
  <header><span class="num">${esc(i.num)}</span><h2>${esc(i.name)}</h2></header>
  <div class="cmd"><code data-cmd>curl -LOJ ${HOST}/${esc(i.slug)}</code><button class="ghost" data-copy>Copy</button></div>
  <div class="row">
    <a class="btn" href="/${esc(i.slug)}">Download</a>
    <a class="btn alt" href="/d/${esc(i.slug)}">Direct link</a>
    <select aria-label="Command type" data-slug="${esc(i.slug)}"><option value="curl">curl</option><option value="wget">wget</option><option value="direct">curl, no proxy</option></select>
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
.term{background:var(--term);color:var(--termink);border-radius:14px;padding:6px 20px;font:14.5px/1.6 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace}
.term div{display:flex;gap:14px;align-items:center;justify-content:space-between;padding:12px 0;flex-wrap:wrap}
.term div+div{border-top:1px solid #1f3358}
.term b{color:#fff;font-weight:600}.term small{display:block;color:#7f9bc4;font-size:12.5px}
.term button{background:var(--acc);color:var(--accink);border:0;border-radius:8px;padding:8px 14px;font-weight:700;cursor:pointer}
.bar{margin:30px 0 18px}
input[type=search]{width:100%;max-width:420px;padding:11px 14px;border-radius:10px;border:1px solid var(--line);background:var(--panel);color:var(--ink);font:inherit}
.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(310px,1fr));gap:16px}
.card{background:var(--panel);border:1px solid var(--line);border-radius:14px;padding:18px;display:flex;flex-direction:column;gap:14px}
.card[hidden]{display:none}
.card header{display:flex;gap:12px;align-items:center}
.card h2{font-size:1.1rem;margin:0}
.num{min-width:34px;height:34px;display:grid;place-items:center;border-radius:9px;background:var(--acc);color:var(--accink);font:700 15px ui-monospace,Menlo,Consolas,monospace}
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
<p class="lead">Short links for the installers I use. Click to download, copy a command, or pick several by number in a terminal.</p>
<div class="term">
<div><span><b>irm ${HOST}/w | iex</b><small>Windows PowerShell: numbered menu, type 1 3 5 to grab several.</small></span><button data-copy-text="irm ${HOST}/w | iex">Copy</button></div>
<div><span><b>bash &lt;(curl -fsSL ${HOST}/i)</b><small>Linux and macOS: same menu. Falls back to wget.</small></span><button data-copy-text="bash <(curl -fsSL ${HOST}/i)">Copy</button></div>
</div>
<div class="bar"><input type="search" id="q" placeholder="Search apps" aria-label="Search apps"></div>
<section class="grid" id="g">${cards}</section><p class="empty" id="e">Nothing matches. Clear the search.</p>
<footer>${items.length} links. <a href="/api.json">JSON</a> · <a href="/list">Plain text</a></footer></main>
<script>
const H=${JSON.stringify(HOST)};
const q=document.getElementById('q'),cards=[...document.querySelectorAll('.card')];
q.oninput=()=>{let n=0;cards.forEach(c=>{const ok=c.dataset.q.includes(q.value.toLowerCase());c.hidden=!ok;if(ok)n++});document.getElementById('e').style.display=n?'none':'block'};
async function copy(t,b){try{await navigator.clipboard.writeText(t)}catch(e){}const o=b.textContent;b.textContent='Copied';setTimeout(()=>b.textContent=o,1200)}
document.querySelectorAll('[data-copy-text]').forEach(b=>b.onclick=()=>copy(b.dataset.copyText,b));
cards.forEach(c=>{const code=c.querySelector('[data-cmd]'),sel=c.querySelector('select'),s=sel.dataset.slug;
sel.onchange=()=>{code.textContent={curl:'curl -LOJ '+H+'/'+s,wget:'wget --content-disposition '+H+'/'+s,direct:'curl -LOJ '+H+'/d/'+s}[sel.value]};
c.querySelector('[data-copy]').onclick=e=>copy(code.textContent,e.target)});
</script></body></html>`;
}
