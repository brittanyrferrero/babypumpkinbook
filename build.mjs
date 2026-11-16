// Builds the static site from content/ into dist/.
//
//   content/<N>-<name>/      -> book page N; the name is for humans only
//   content/<N>-<name>/page.md   -> "# Title" on the first line
//   content/<N>-<name>/NN.md     -> one fact per file (01.md, 02.md, ...)
//   content/<N>-<name>/NN.mp3    -> optional audio for that fact (mp3, m4a, mp4, ogg, wav; mp4 plays as sound only)
//   content/<N>-<name>/cover.*   -> optional picture shown on the page (jpg, png, webp)
//
//   dist/p/<N>               -> picks a random fact and jumps to it  (this is the URL on the NFC tag)
//   dist/p/<N>/<n>           -> one fact, with its audio
//   dist/random              -> random page, random fact
//   dist/tags.json, tags.txt -> slug -> URL list for writing the tags
//
// No dependencies. Run with `node build.mjs`. Set SITE_URL to get absolute URLs
// in tags.txt (Vercel sets VERCEL_PROJECT_PRODUCTION_URL automatically).

import { readdirSync, readFileSync, writeFileSync, mkdirSync, rmSync, copyFileSync, existsSync, statSync } from "node:fs";
import { join, extname } from "node:path";

const CONTENT = "content";
const DIST = "dist";
const AUDIO_EXT = [".mp3", ".m4a", ".mp4", ".ogg", ".wav"];
const IMAGE_EXT = [".jpg", ".jpeg", ".png", ".webp", ".gif"];
const SITE_URL = (process.env.SITE_URL
  || (process.env.VERCEL_PROJECT_PRODUCTION_URL && `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}`)
  || "").replace(/\/$/, "");

// ---------- tiny markdown: paragraphs, **bold**, *italic*, [links](url) ----------
const esc = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
function inline(s) {
  return esc(s)
    .replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
    .replace(/\*(.+?)\*/g, "<em>$1</em>")
    .replace(/\[(.+?)\]\((https?:\/\/[^)\s]+)\)/g, '<a href="$2">$1</a>');
}
function md(text) {
  return text.trim().split(/\n\s*\n/).map((p) => `<p>${inline(p.trim().replace(/\s*\n\s*/g, " "))}</p>`).join("\n");
}

// ---------- read content ----------
// Folder "3-ocean" -> page 3 (URL /p/3). The number is what the tag holds; the
// name after the dash is just for humans and can change along with the content.
function slugOf(folder) {
  const m = /^(\d+)/.exec(folder);
  return m ? String(parseInt(m[1], 10)) : folder;
}
function readPage(folder) {
  const slug = slugOf(folder);
  const dir = join(CONTENT, folder);
  const files = readdirSync(dir).sort();
  let title = slug, blurb = "";
  if (files.includes("page.md")) {
    const lines = readFileSync(join(dir, "page.md"), "utf8").split("\n");
    const h = lines.findIndex((l) => l.startsWith("# "));
    if (h >= 0) { title = lines[h].slice(2).trim(); lines.splice(h, 1); }
    const e = lines.findIndex((l) => /^emoji:\s*/.test(l));
    if (e >= 0) lines.splice(e, 1); // old "emoji:" lines are ignored
    blurb = lines.join("\n").trim();
  }
  const cover = files.find((f) => f.startsWith("cover.") && IMAGE_EXT.includes(extname(f).toLowerCase()));
  const facts = files
    .filter((f) => /^\d+\.md$/.test(f))
    .map((f) => {
      const n = String(parseInt(f, 10));
      const stem = f.replace(/\.md$/, "");
      const audio = files.find((a) => a.startsWith(stem + ".") && AUDIO_EXT.includes(extname(a).toLowerCase()));
      return { n, html: md(readFileSync(join(dir, f), "utf8")), audio };
    });
  return { slug, folder, title, blurb, cover, facts };
}

const folders = readdirSync(CONTENT).filter((d) => !d.startsWith("_") && !d.startsWith(".") && statSync(join(CONTENT, d)).isDirectory());
const pages = folders.map(readPage).filter((p) => p.facts.length > 0)
  .sort((a, b) => (Number(a.slug) || 1e9) - (Number(b.slug) || 1e9) || a.slug.localeCompare(b.slug));
{
  const seen = new Set();
  for (const p of pages) { if (seen.has(p.slug)) throw new Error(`two content folders map to page ${p.slug}`); seen.add(p.slug); }
}

// ---------- templates ----------
const CSS = `
:root{--bg:#f5efe4;--surface:#fdf8f1;--raised:#f0e8da;--border:#e0d5c4;--border-strong:#cdc0ac;--accent:#4d6e5e;--accent-ink:#fff;--accent-light:#eaf0eb;--accent-mid:#9abfae;--text:#2a2218;--muted:#9a8e7e;--faint:#c4b8a6;--weave:rgba(160,130,90,.05);--shadow-sm:0 1px 2px rgba(42,34,24,.06),0 2px 6px rgba(42,34,24,.05);--shadow-md:0 2px 8px rgba(42,34,24,.07),0 6px 28px rgba(42,34,24,.08);color-scheme:light dark}
@media(prefers-color-scheme:dark){:root{--bg:#1c1915;--surface:#25211c;--raised:#2d2822;--border:#3a342c;--border-strong:#4a4238;--accent:#9abfae;--accent-ink:#1c1915;--accent-light:#26302b;--accent-mid:#5f7d6f;--text:#efe7da;--muted:#a3978a;--faint:#6f665b;--weave:rgba(240,220,190,.025);--shadow-sm:0 1px 2px rgba(0,0,0,.25);--shadow-md:0 2px 8px rgba(0,0,0,.25),0 6px 28px rgba(0,0,0,.3)}}
*{box-sizing:border-box}html{-webkit-text-size-adjust:100%}
body{margin:0;background-color:var(--bg);background-image:repeating-linear-gradient(0deg,transparent,transparent 3px,var(--weave) 3px,var(--weave) 4px),repeating-linear-gradient(90deg,transparent,transparent 3px,var(--weave) 3px,var(--weave) 4px);color:var(--text);font-family:"Inter",system-ui,-apple-system,sans-serif;line-height:1.5;min-height:100svh;display:flex;flex-direction:column}
main{flex:1;width:100%;max-width:36rem;margin:0 auto;padding:2.25rem 1.25rem 2rem}
.label{font-size:.68rem;font-weight:600;letter-spacing:.1em;text-transform:uppercase;color:var(--faint);margin:0 0 .75rem}
h1{font-size:2.4rem;font-weight:300;letter-spacing:-.03em;line-height:1.1;margin:0 0 .4rem}
h1 em{font-style:italic;color:var(--accent)}
.blurb{color:var(--muted);margin:0 0 1.5rem;font-size:1.02rem}
.cover{width:100%;border-radius:16px;margin:0 0 1.25rem;display:block;border:1px solid var(--border);box-shadow:var(--shadow-sm)}
.fact{background:var(--surface);border:1px solid var(--border);border-radius:20px;padding:1.6rem 1.5rem;font-size:1.32rem;line-height:1.5;box-shadow:var(--shadow-md)}
.fact p{margin:0 0 .75em}.fact p:last-child{margin:0}
.fact strong{color:var(--accent);font-weight:600}
.fact a{color:var(--accent)}
.audio{margin:1.25rem 0 0}
.play{display:flex;align-items:center;justify-content:center;gap:.6rem;width:100%;min-height:3.9rem;border:1px solid var(--accent);border-radius:999px;padding:1rem 1.25rem;font:inherit;font-size:1.15rem;font-weight:500;letter-spacing:.01em;background:var(--accent);color:var(--accent-ink);cursor:pointer;box-shadow:var(--shadow-sm);transition:transform .08s,background .15s}
.play:active{transform:scale(.98)}
.play[aria-pressed="true"]{background:var(--accent-light);color:var(--accent);border-color:var(--accent-mid)}
.btn{display:inline-block;text-align:center;text-decoration:none;border:1px solid var(--accent);color:var(--accent-ink);background:var(--accent);border-radius:999px;padding:.7rem 1.2rem;font-weight:500;font-size:.95rem}
footer{text-align:center;color:var(--faint);font-size:.66rem;font-weight:600;letter-spacing:.12em;text-transform:uppercase;padding:1rem 1.25rem 1.8rem}
footer a{color:inherit}
ul.pages{list-style:none;padding:0;margin:1.5rem 0 0;background:var(--surface);border:1px solid var(--border);border-radius:16px;box-shadow:var(--shadow-sm);overflow:hidden}
ul.pages li{padding:.95rem 1.1rem;border-top:1px solid var(--border)}
ul.pages li:first-child{border-top:0}
ul.pages a{color:inherit;text-decoration:none;font-weight:500;font-size:1.05rem}
ul.pages small{display:block;color:var(--muted);margin-top:.15rem;font-size:.8rem}
code{background:var(--raised);border-radius:6px;padding:.1em .4em;font-size:.88em}
`;

function shell({ title, body, head = "" }) {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex">
<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Inter:ital,opsz,wght@0,14..32,300;0,14..32,400;0,14..32,500;0,14..32,600;1,14..32,300;1,14..32,400&display=swap">
<title>${esc(title)}</title>
<style>${CSS}</style>
${head}
</head>
<body>
<main>
${body}
</main>
<footer>Pumpkin's book of wonders · 🎃</footer>
</body>
</html>
`;
}

// /p/<slug> : pick a random fact (avoiding the last one shown on this phone) and go there.
function randomPage(p) {
  const ns = JSON.stringify(p.facts.map((f) => f.n));
  const links = p.facts.map((f) => `<li><a href="/p/${p.slug}/${f.n}">Fact ${f.n}</a></li>`).join("");
  return shell({
    title: p.title,
    head: `<script>
(function(){
  var ns=${ns}, key="last-${p.slug}", last=null;
  try{last=localStorage.getItem(key)}catch(e){}
  var pool=ns.length>1?ns.filter(function(n){return n!==last}):ns;
  var pick=pool[Math.floor(Math.random()*pool.length)];
  try{localStorage.setItem(key,pick)}catch(e){}
  location.replace("/p/${p.slug}/"+pick);
})();
</script>`,
    body: `<p class="label">Picking a fact…</p><h1>${esc(p.title)}</h1>
<noscript><p>Pick one:</p><ul>${links}</ul></noscript>`,
  });
}

// /p/<slug>/<n> : one fact with its audio.
function factPage(p, f) {
  const audioSrc = f.audio ? `/audio/${p.slug}/${f.audio}` : null;
  const cover = p.cover ? `<img class="cover" src="/img/${p.slug}/${p.cover}" alt="">` : "";
  const audio = audioSrc
    ? `<div class="audio">
<button class="play" id="play" type="button" aria-pressed="false">▶ &nbsp;Listen</button>
<audio id="a" src="${audioSrc}" preload="auto"></audio>
</div>
<script>
(function(){
  var a=document.getElementById("a"), b=document.getElementById("play");
  b.addEventListener("click",function(){ if(a.paused){a.play()}else{a.pause()} });
  a.addEventListener("play",function(){b.textContent="❚❚  Pause";b.setAttribute("aria-pressed","true")});
  a.addEventListener("pause",function(){b.textContent="▶  Listen";b.setAttribute("aria-pressed","false")});
  a.addEventListener("ended",function(){b.textContent="↻  Listen again";b.setAttribute("aria-pressed","false")});
})();
</script>`
    : "";
  return shell({
    title: `${p.title} · fact ${f.n}`,
    body: `<h1>${esc(p.title)}</h1>
${cover}
<div class="fact">${f.html}</div>
${audio}`,
  });
}

// /random : random page, then random fact on it. Avoids the last one shown on this phone.
function randomAnyPage() {
  const table = JSON.stringify(Object.fromEntries(pages.map((p) => [p.slug, p.facts.map((f) => f.n)])));
  const links = pages.map((p) => `<li><a href="/p/${p.slug}">${esc(p.title)}</a></li>`).join("");
  return shell({
    title: "A random wonder",
    head: `<script>
(function(){
  var t=${table}, slugs=Object.keys(t), last=null;
  try{last=localStorage.getItem("last-any")}catch(e){}
  var all=[]; slugs.forEach(function(s){ t[s].forEach(function(n){ all.push(s+"/"+n) }) });
  var pool=all.length>1?all.filter(function(x){return x!==last}):all;
  var s=slugs[Math.floor(Math.random()*slugs.length)];
  var ns=t[s].filter(function(n){return pool.indexOf(s+"/"+n)>=0});
  if(!ns.length){ s=pool[0].split("/")[0]; ns=[pool[0].split("/")[1]]; }
  var pick=s+"/"+ns[Math.floor(Math.random()*ns.length)];
  try{localStorage.setItem("last-any",pick)}catch(e){}
  location.replace("/p/"+pick);
})();
</script>`,
    body: `<p class="label">Picking a wonder…</p><h1>A random <em>wonder</em></h1>
<noscript><p>Pick a page:</p><ul>${links}</ul></noscript>`,
  });
}

function indexPage() {
  const items = pages.map((p) => `<li><div><a href="/p/${p.slug}">Page ${esc(p.slug)} · ${esc(p.title)}</a><small>${p.facts.length} fact${p.facts.length === 1 ? "" : "s"}${p.facts.filter((f) => f.audio).length ? `, ${p.facts.filter((f) => f.audio).length} with audio` : ""} · tag URL: <code>/p/${p.slug}</code></small></div></li>`).join("\n");
  return shell({
    title: "Pumpkin's book of wonders",
    body: `<p class="label">For the grown-ups</p><h1>Pumpkin's book of <em>wonders</em></h1>
<p class="blurb">Each page of the book has a tag. Scan it and a fact pops up. This list is just for the grown-ups.</p>
<p><a class="btn" href="/random">Surprise me</a> &nbsp;<a href="/admin" style="color:var(--muted);font-size:.9rem">Dashboard</a></p>
<ul class="pages">${items}</ul>`,
  });
}

// ---------- write ----------
rmSync(DIST, { recursive: true, force: true });
mkdirSync(DIST, { recursive: true });
const out = (rel, text) => { mkdirSync(join(DIST, rel, ".."), { recursive: true }); writeFileSync(join(DIST, rel), text); };

out("index.html", indexPage());
out("admin/index.html", readFileSync("admin/index.html", "utf8"));
out("random/index.html", randomAnyPage());
const tags = {};
for (const p of pages) {
  out(`p/${p.slug}/index.html`, randomPage(p));
  for (const f of p.facts) {
    out(`p/${p.slug}/${f.n}/index.html`, factPage(p, f));
    if (f.audio) {
      mkdirSync(join(DIST, "audio", p.slug), { recursive: true });
      copyFileSync(join(CONTENT, p.folder, f.audio), join(DIST, "audio", p.slug, f.audio));
    }
  }
  if (p.cover) {
    mkdirSync(join(DIST, "img", p.slug), { recursive: true });
    copyFileSync(join(CONTENT, p.folder, p.cover), join(DIST, "img", p.slug, p.cover));
  }
  tags[p.slug] = { title: p.title, url: `${SITE_URL}/p/${p.slug}`, facts: p.facts.length, audio: p.facts.filter((f) => f.audio).length };
}
out("tags.json", JSON.stringify(tags, null, 2) + "\n");
out("tags.txt", pages.map((p) => `${p.slug}\t${SITE_URL}/p/${p.slug}\t${p.title}`).join("\n") + "\n");

for (const p of pages) {
  const missing = p.facts.filter((f) => !f.audio).length;
  console.log(`${(p.slug + "  " + p.folder).padEnd(20)} ${String(p.facts.length).padStart(2)} facts${missing ? `  (${missing} without audio)` : ""}`);
}
console.log(`\nbuilt ${pages.length} pages -> ${DIST}/  (tag URLs in ${DIST}/tags.txt${SITE_URL ? "" : "; set SITE_URL for absolute URLs"})`);
