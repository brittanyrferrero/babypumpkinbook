// Builds the static site from content/ into dist/.
//
//   content/<N>-<name>/      -> book page N; the name is for humans only
//   content/<N>-<name>/page.md   -> "# Title" on the first line, optional blurb, optional "emoji: 🐘"
//   content/<N>-<name>/NN.md     -> one fact per file (01.md, 02.md, ...)
//   content/<N>-<name>/NN.mp3    -> optional audio for that fact (mp3, m4a, ogg, wav)
//   content/<N>-<name>/cover.*   -> optional picture shown on the page (jpg, png, webp)
//
//   dist/p/<N>               -> picks a random fact and jumps to it  (this is the URL on the NFC tag)
//   dist/p/<N>/<n>           -> one fact, with its audio
//   dist/tags.json, tags.txt -> slug -> URL list for writing the tags
//
// No dependencies. Run with `node build.mjs`. Set SITE_URL to get absolute URLs
// in tags.txt (Vercel sets VERCEL_PROJECT_PRODUCTION_URL automatically).

import { readdirSync, readFileSync, writeFileSync, mkdirSync, rmSync, copyFileSync, existsSync, statSync } from "node:fs";
import { join, extname } from "node:path";

const CONTENT = "content";
const DIST = "dist";
const AUDIO_EXT = [".mp3", ".m4a", ".ogg", ".wav"];
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
  let title = slug, blurb = "", emoji = "";
  if (files.includes("page.md")) {
    const lines = readFileSync(join(dir, "page.md"), "utf8").split("\n");
    const h = lines.findIndex((l) => l.startsWith("# "));
    if (h >= 0) { title = lines[h].slice(2).trim(); lines.splice(h, 1); }
    const e = lines.findIndex((l) => /^emoji:\s*/.test(l));
    if (e >= 0) { emoji = lines[e].replace(/^emoji:\s*/, "").trim(); lines.splice(e, 1); }
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
  return { slug, folder, title, blurb, emoji, cover, facts };
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
:root{--bg:#fff8ee;--paper:#fffdf8;--ink:#3a2c22;--muted:#8d7360;--accent:#e9782f;--accent-2:#f5b04c;--accent-ink:#fff;--line:#f1d3ad;--dot:#f3dcc0;--shadow:0 10px 30px rgba(120,70,20,.12);color-scheme:light dark}
@media(prefers-color-scheme:dark){:root{--bg:#211913;--paper:#2b211a;--ink:#f7ebdc;--muted:#c4a88b;--accent:#f18a3c;--accent-2:#f7bd63;--line:#5b4129;--dot:#31251c;--shadow:0 10px 30px rgba(0,0,0,.35)}}
*{box-sizing:border-box}html{-webkit-text-size-adjust:100%}
body{margin:0;background:var(--bg) radial-gradient(var(--dot) 1.2px,transparent 1.3px) 0 0/22px 22px;color:var(--ink);font-family:"Nunito",ui-rounded,"SF Pro Rounded","Segoe UI",system-ui,sans-serif;line-height:1.5;min-height:100svh;display:flex;flex-direction:column}
main{flex:1;width:100%;max-width:36rem;margin:0 auto;padding:1.75rem 1.25rem 2rem}
.display{font-family:"Fraunces","Iowan Old Style","Palatino Linotype",Georgia,serif;font-variation-settings:"SOFT" 100,"WONK" 1;font-weight:600;letter-spacing:-.01em}
.eyebrow{color:var(--muted);letter-spacing:.14em;text-transform:uppercase;font-size:.72rem;font-weight:800;margin:0 0 .6rem}
.eyebrow::before{content:"✦ ";color:var(--accent-2)}
.sticker{display:inline-grid;place-items:center;width:4.25rem;height:4.25rem;font-size:2.4rem;background:var(--paper);border:2px solid var(--line);border-radius:1.4rem;box-shadow:var(--shadow);transform:rotate(-6deg);margin:0 0 .9rem}
h1{font-size:2.35rem;line-height:1.1;margin:0 0 .35rem}
.blurb{color:var(--muted);margin:0 0 1.35rem;font-size:1.05rem;font-style:italic}
.cover{width:100%;border-radius:1.25rem;margin:0 0 1.25rem;display:block;border:2px solid var(--line);box-shadow:var(--shadow)}
.fact{position:relative;background:var(--paper);border:2px solid var(--line);border-radius:1.5rem;padding:1.5rem 1.4rem 1.4rem;font-size:1.4rem;line-height:1.42;box-shadow:var(--shadow);transform:rotate(-.6deg)}
.fact>*{transform:rotate(.6deg)}
.fact p{margin:0 0 .75em}.fact p:last-child{margin:0}
.fact strong{color:var(--accent)}
.audio{margin:1.4rem 0 0}
.play{display:flex;align-items:center;justify-content:center;gap:.6rem;width:100%;border:0;border-radius:999px;padding:1.05rem 1.25rem;font:inherit;font-size:1.15rem;font-weight:800;background:linear-gradient(180deg,var(--accent-2),var(--accent));color:var(--accent-ink);cursor:pointer;box-shadow:0 6px 0 rgba(150,70,10,.25);transition:transform .08s,box-shadow .08s}
.play:active{transform:translateY(4px);box-shadow:0 2px 0 rgba(150,70,10,.25)}
.play[aria-pressed="true"]{background:var(--muted);box-shadow:none}
audio{width:100%;margin-top:.75rem;border-radius:999px}
.actions{display:flex;flex-wrap:wrap;gap:.75rem;margin-top:1.4rem}
.btn{flex:1 1 10rem;text-align:center;text-decoration:none;border:2px solid var(--accent);color:var(--accent);border-radius:999px;padding:.85rem 1rem;font-weight:800;background:var(--paper)}
.btn.primary{background:var(--accent);color:var(--accent-ink);border-color:var(--accent)}
footer{text-align:center;color:var(--muted);font-size:.95rem;padding:1rem 1.25rem 1.6rem}
footer a{color:inherit}
ul.pages{list-style:none;padding:0;margin:0;display:grid;gap:.75rem}
ul.pages li{background:var(--paper);border:2px solid var(--line);border-radius:1.25rem;padding:1rem 1.1rem;display:grid;grid-template-columns:auto 1fr;gap:.9rem;align-items:center;box-shadow:var(--shadow)}
ul.pages .em{font-size:1.9rem}
ul.pages a{color:inherit;text-decoration:none;font-weight:800;font-size:1.15rem}
ul.pages small{display:block;color:var(--muted);margin-top:.2rem}
code{background:var(--bg);border:1px solid var(--line);border-radius:.4rem;padding:.1em .35em;font-size:.9em}
`;

function shell({ title, body, head = "" }) {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex">
<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Fraunces:opsz,wght,SOFT,WONK@9..144,600,100,1&family=Nunito:wght@400;700;800&display=swap">
<title>${esc(title)}</title>
<style>${CSS}</style>
${head}
</head>
<body>
<main>
${body}
</main>
<footer class="display">Pumpkin's book of wonders 🎃</footer>
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
    body: `<p class="eyebrow">Picking a fact…</p><h1 class="display">${esc(p.title)}</h1>
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
<audio id="a" src="${audioSrc}" preload="auto" controls></audio>
</div>
<script>
(function(){
  var a=document.getElementById("a"), b=document.getElementById("play");
  b.addEventListener("click",function(){ if(a.paused){a.play()}else{a.pause()} });
  a.addEventListener("play",function(){b.textContent="❚❚  Pause";b.setAttribute("aria-pressed","true")});
  a.addEventListener("pause",function(){b.textContent="▶  Listen";b.setAttribute("aria-pressed","false")});
  a.addEventListener("ended",function(){b.textContent="↻  Listen again";b.setAttribute("aria-pressed","false")});
  // Try to start automatically; phones usually block this until a tap, and that's fine.
  var t=a.play(); if(t&&t.catch){t.catch(function(){})}
})();
</script>`
    : "";
  return shell({
    title: `${p.title} · fact ${f.n}`,
    body: `${p.emoji ? `<div class="sticker" aria-hidden="true">${p.emoji}</div>` : ""}
<h1 class="display">${esc(p.title)}</h1>
${p.blurb ? `<p class="blurb">${inline(p.blurb)}</p>` : ""}
${cover}
<div class="fact">${f.html}</div>
${audio}`,
  });
}

function indexPage() {
  const items = pages.map((p) => `<li><span class="em" aria-hidden="true">${p.emoji || "📖"}</span><div><a href="/p/${p.slug}">Page ${esc(p.slug)} · ${esc(p.title)}</a><small>${p.facts.length} fact${p.facts.length === 1 ? "" : "s"}${p.facts.filter((f) => f.audio).length ? `, ${p.facts.filter((f) => f.audio).length} with audio` : ""} · tag URL: <code>/p/${p.slug}</code></small></div></li>`).join("\n");
  return shell({
    title: "Pumpkin's book of wonders",
    body: `<p class="eyebrow">Index</p><h1 class="display">Pumpkin's book of wonders</h1>
<p class="blurb">Each page of the book has a tag. Scan it and a fact pops up. This list is just for the grown-ups.</p>
<ul class="pages">${items}</ul>`,
  });
}

// ---------- write ----------
rmSync(DIST, { recursive: true, force: true });
mkdirSync(DIST, { recursive: true });
const out = (rel, text) => { mkdirSync(join(DIST, rel, ".."), { recursive: true }); writeFileSync(join(DIST, rel), text); };

out("index.html", indexPage());
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
