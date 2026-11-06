// Cloudflare Worker. No secrets.
const HOST = 'https://get.harry.run';
const PROXY = 'https://dl.harry.run/download?url='; // proxy picks the real file name + extension

// ---------- url.txt is bundled into the worker at deploy time ----------
import raw from './url.txt';

const items = raw.split('\n')
  .map(l => l.trim())
  .filter(l => l && !l.startsWith('#'))
  .map(l => {
    const [num, slug, name, url, pattern, silent] = l.split('|').map(s => s.trim());
    return { num, slug, name, url, pattern: pattern || '', silent: silent || '' };
  })
  .filter(i => i.num && i.slug && i.url)
  .sort((a, b) => Number(a.num) - Number(b.num));
const bySlug = Object.fromEntries(items.map(i => [i.slug, i]));
const byNum = Object.fromEntries(items.map(i => [i.num, i]));

const proxied = i => PROXY + encodeURIComponent(i.url);
const esc = s => s.replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const text = (b, status = 200) => new Response(b, { status, headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-cache' } });
const html = b => new Response(b, { headers: { 'content-type': 'text/html; charset=utf-8' } });
const json = o => new Response(JSON.stringify(o, null, 2), { headers: { 'content-type': 'application/json', 'access-control-allow-origin': '*' } });

export default {
  async fetch(req) {
    const u = new URL(req.url);
    const path = u.pathname.replace(/\/+$/, '') || '/';
    const ua = req.headers.get('user-agent') || '';
    const ps = /PowerShell/i.test(ua);
    const cli = /curl|wget|httpie|fetch|python-requests|go-http/i.test(ua) ||
      !(req.headers.get('accept') || '').includes('text/html');

    // One address for everything: PowerShell -> Windows installer menu, curl/wget -> shell menu, browser -> page
    if (path === '/') return ps ? text(powershellScript()) : cli ? text(shellScript()) : html(page());
    if (path === '/url.txt') return text(raw);
    if (path === '/list') return text(menu());
    if (path === '/raw') return text(items.map(i => [i.num, i.slug, i.name, i.silent].join('|')).join('\n') + '\n');
    if (path === '/api.json') return json(items.map(i => ({ num: i.num, slug: i.slug, name: i.name, url: i.url, proxy: proxied(i), short: `${HOST}/${i.slug}` })));

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

// ---------- plain list (get.harry.run/list) ----------
function menu() {
  const w = Math.max(...items.map(i => i.slug.length)) + 2;
  const rows = items.map(i => `  ${i.num.padStart(2)}  ${i.slug.padEnd(w)}${i.name}`).join('\n');
  return `get.harry.run - download links

${rows}

Download one (file name and extension come from the proxy)
  curl -LOJ ${HOST}/<name or number>
  wget --content-disposition ${HOST}/<name or number>
  curl -LOJ ${HOST}/d/<name>          skip the proxy, go straight to the vendor

Pick several from a menu
  Windows (downloads and installs)   irm ${HOST} | iex
  Linux / macOS                      curl -fsSL ${HOST} | bash
`;
}

// ---------- interactive: Linux / macOS ----------
function shellScript() {
  return String.raw`#!/usr/bin/env bash
# get.harry.run interactive downloader
# Run it with:  curl -fsSL __HOST__ | bash    (or: wget -qO- __HOST__ | bash)
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
while IFS='|' read -r num s n _; do
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
`.replaceAll('__HOST__', HOST).replaceAll('@{', '$' + '{');
}

// ---------- interactive: Windows PowerShell (irm https://get.harry.run | iex) ----------
function powershellScript() {
  return String.raw`# get.harry.run - pick apps by number, download and install (Windows)
$H = "__HOST__"
if (-not (Get-Command curl.exe -ErrorAction SilentlyContinue)) { Write-Host "curl.exe not found (it ships with Windows 10 and 11)." -ForegroundColor Red; return }
$items = [ordered]@{}
foreach ($r in ((Invoke-RestMethod "$H/raw") -split "\r?\n")) {
  if ($r.Trim()) { $p = $r.Split('|', 4); $items[$p[0]] = $p }
}
Write-Host ""; Write-Host "get.harry.run" -ForegroundColor Cyan; Write-Host ""
foreach ($k in $items.Keys) { Write-Host ("  {0,2}  {1}" -f $k, $items[$k][2]) }
Write-Host ""
$pick = Read-Host "Pick number(s), e.g. 1 3 5 (q = quit)"
if (-not $pick -or $pick -eq 'q') { return }
$ans = Read-Host "Install after download? [Y/n] (n = just save the files here)"
$install = $ans -notmatch '^[nN]'
$here = (Get-Location).Path
$dir = $here
if ($install) { $dir = Join-Path $env:TEMP "get-harry-run"; New-Item -ItemType Directory -Force $dir | Out-Null }

foreach ($n in ($pick -split "[\s,]+" | Where-Object { $_ })) {
  if (-not $items.Contains($n)) { Write-Host "Skipping invalid choice: $n" -ForegroundColor Yellow; continue }
  $it = $items[$n]
  Write-Host ""; Write-Host ("-> " + $it[2]) -ForegroundColor Cyan
  if ($install) { Get-ChildItem $dir -Force | Remove-Item -Recurse -Force }
  Push-Location $dir
  curl.exe -fLOJ --progress-bar ("$H/" + $it[1])
  $ok = ($LASTEXITCODE -eq 0)
  Pop-Location
  if (-not $ok) { Write-Host "   download failed" -ForegroundColor Red; continue }
  if (-not $install) { continue }

  $f = Get-ChildItem $dir -File | Sort-Object LastWriteTime -Descending | Select-Object -First 1
  $silent = $it[3]
  if ($f.Extension -eq '.msi') { $exe = 'msiexec.exe'; $a = '/i "' + $f.FullName + '" /qn /norestart' }
  else { $exe = $f.FullName; $a = $silent }
  if ($silent) { Write-Host "   installing (approve the admin prompt)..." } else { Write-Host "   opening the installer, finish it in the window..." }
  try {
    $sp = @{ FilePath = $exe; Wait = $true; PassThru = $true; Verb = 'RunAs' }
    if ($a) { $sp.ArgumentList = $a }
    $proc = Start-Process @sp
    if ($proc.ExitCode -eq 0 -or $proc.ExitCode -eq 3010) { Write-Host "   done" -ForegroundColor Green }
    else { Write-Host ("   installer exited with code " + $proc.ExitCode) -ForegroundColor Yellow }
  } catch { Write-Host ("   could not run the installer: " + $_.Exception.Message) -ForegroundColor Red }
}
if ($install) { Remove-Item $dir -Recurse -Force -ErrorAction SilentlyContinue }
Write-Host ""; Write-Host "Finished." -ForegroundColor Green
`.replaceAll('__HOST__', HOST);
}

// ---------- WebUI ----------
function page() {
  const rows = items.map(i => `
<li class="item" data-q="${esc((i.name + ' ' + i.slug + ' ' + i.num).toLowerCase())}">
  <div class="row">
    <span class="n">${esc(i.num)}</span>
    <div class="who"><div class="name">${esc(i.name)}</div><div class="slug">get.harry.run/${esc(i.slug)}</div></div>
    <a class="dl" href="/${esc(i.slug)}">Download</a>
  </div>
  <div class="cmds">
    <code title="Click to copy">curl -LOJ ${HOST}/${esc(i.slug)}</code>
    <code title="Click to copy">wget --content-disposition ${HOST}/${esc(i.slug)}</code>
    <code title="Click to copy">curl -LOJ ${HOST}/d/${esc(i.slug)}</code>
  </div>
</li>`).join('');

  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>get.harry.run</title><meta name="color-scheme" content="light dark">
<style>
:root{--bg:#f4f7f7;--ink:#10242b;--mute:#5d7378;--line:#d7e2e2;--code:#e4edee;--acc:#0a7b83;--accink:#fff}
@media (prefers-color-scheme:dark){:root{--bg:#0f1a1c;--ink:#e6f1f1;--mute:#8aa5a8;--line:#223436;--code:#152527;--acc:#4fcfc6;--accink:#06201f}}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--ink);font:16px/1.5 "Segoe UI Variable Text","Segoe UI",ui-sans-serif,system-ui,-apple-system,Roboto,sans-serif}
main{max-width:760px;margin:0 auto;padding:72px 24px 96px}
h1{margin:0;font-size:clamp(2.6rem,9vw,4.8rem);line-height:1;font-weight:800;letter-spacing:-.045em}
.sub{margin:16px 0 40px;color:var(--mute);max-width:42ch}
.tools{display:flex;gap:10px;margin-bottom:22px}
input[type=search]{flex:1;min-width:0;padding:11px 14px;border-radius:10px;border:1px solid var(--line);background:transparent;color:var(--ink);font:inherit}
input[type=search]::placeholder{color:var(--mute)}
.tg{padding:0 16px;border-radius:10px;border:1px solid var(--line);background:transparent;color:var(--ink);font:inherit;cursor:pointer}
.tg[aria-pressed=true]{background:var(--ink);color:var(--bg);border-color:var(--ink)}
.termbox{display:none;margin:0 0 26px;padding:16px 18px;border-radius:12px;background:var(--code)}
.termbox p{margin:0 0 10px;color:var(--mute);font-size:.92rem}
.line{display:grid;grid-template-columns:110px 1fr;gap:10px;align-items:center;padding:5px 0}
.line span{color:var(--mute);font-size:.9rem}
body.term .termbox,body.term .cmds{display:block}
code{font:13px/1.5 ui-monospace,"Cascadia Code",SFMono-Regular,Menlo,Consolas,monospace;cursor:pointer;overflow-wrap:anywhere}
ol{list-style:none;margin:0;padding:0;border-top:1px solid var(--line)}
.item{border-bottom:1px solid var(--line)}
.item[hidden]{display:none}
.row{display:grid;grid-template-columns:72px 1fr auto;align-items:center;gap:6px;padding:20px 0}
.n{font-size:2.6rem;font-weight:800;line-height:1;font-variant-numeric:tabular-nums;color:transparent;-webkit-text-stroke:1.5px var(--acc)}
.item:hover .n{color:var(--acc)}
.name{font-size:1.18rem;font-weight:650;letter-spacing:-.01em}
.slug{color:var(--mute);font-size:.86rem}
.dl{background:var(--acc);color:var(--accink);text-decoration:none;font-weight:700;padding:10px 20px;border-radius:10px}
.dl:hover{filter:brightness(1.08)}
.cmds{display:none;padding:0 0 20px 78px}
.cmds code{display:block;margin-top:6px;padding:8px 12px;border-radius:8px;background:var(--code)}
:focus-visible{outline:3px solid var(--acc);outline-offset:2px}
.empty{display:none;color:var(--mute);padding:28px 0}
footer{margin-top:36px;color:var(--mute);font-size:.88rem}footer a{color:var(--ink)}
@media (max-width:520px){.row{grid-template-columns:48px 1fr auto}.n{font-size:1.9rem}.cmds{padding-left:54px}.line{grid-template-columns:1fr}.dl{padding:9px 14px}}
</style></head><body><main>
<h1>get.harry.run</h1>
<p class="sub">The installers I use. Pick one and it downloads with the right file name.</p>
<div class="tools"><input type="search" id="q" placeholder="Search" aria-label="Search apps"><button class="tg" id="tg" aria-pressed="false">Terminal</button></div>
<div class="termbox">
<p>Type several numbers at once, like 1 3 4. On Windows it also installs them.</p>
<div class="line"><span>Windows</span><code title="Click to copy">irm ${HOST} | iex</code></div>
<div class="line"><span>Linux / macOS</span><code title="Click to copy">curl -fsSL ${HOST} | bash</code></div>
</div>
<ol>${rows}</ol><p class="empty" id="e">Nothing matches that search.</p>
<footer>${items.length} apps · <a href="/list">plain list</a> · <a href="/api.json">json</a></footer>
</main>
<script>
var q=document.getElementById('q'),items=[].slice.call(document.querySelectorAll('.item')),tg=document.getElementById('tg');
q.oninput=function(){var n=0;items.forEach(function(c){var ok=c.dataset.q.indexOf(q.value.toLowerCase())>-1;c.hidden=!ok;if(ok)n++});document.getElementById('e').style.display=n?'none':'block'};
tg.onclick=function(){var on=document.body.classList.toggle('term');tg.setAttribute('aria-pressed',on)};
[].slice.call(document.querySelectorAll('code')).forEach(function(c){c.onclick=function(){
  var t=c.textContent;try{navigator.clipboard.writeText(t)}catch(e){}c.textContent='Copied';setTimeout(function(){c.textContent=t},900)}});
</script></body></html>`;
}
