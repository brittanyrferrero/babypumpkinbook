import { requireAuth, gh, json, fail, BRANCH } from "./_lib.js";

// GET → every book page with its facts, straight from the repo (not the
// deployed site), so the dashboard always shows the latest saved state.
export async function GET(req) {
  const denied = requireAuth(req);
  if (denied) return denied;
  try {
    const ref = await gh(`/git/ref/heads/${BRANCH}`);
    const head = ref.object.sha;
    const { tree } = await gh(`/git/trees/${head}?recursive=1`);
    const files = tree.filter((t) => t.type === "blob" && t.path.startsWith("content/"));

    const text = async (sha) => {
      const b = await gh(`/git/blobs/${sha}`);
      return Buffer.from(b.content, "base64").toString("utf8");
    };
    const mdFiles = files.filter((f) => f.path.endsWith(".md") || f.path === "content/recordings.json");
    const texts = Object.fromEntries(await Promise.all(mdFiles.map(async (f) => [f.path, await text(f.sha)])));

    let recordings = {};
    try { recordings = JSON.parse(texts["content/recordings.json"] || "{}"); } catch {}

    const pages = {};
    for (const f of files) {
      const m = /^content\/((\d+)-[^/]+)\/([^/]+)$/.exec(f.path);
      if (!m) continue;
      const [, folder, num, name] = m;
      const p = (pages[folder] ||= { folder, number: Number(num), title: "", blurb: "", emoji: "", cover: null, files: [], facts: {} });
      p.files.push({ name, sha: f.sha, size: f.size });
      if (name === "page.md") {
        const lines = texts[f.path].split("\n");
        const h = lines.findIndex((l) => l.startsWith("# "));
        if (h >= 0) { p.title = lines[h].slice(2).trim(); lines.splice(h, 1); }
        const e = lines.findIndex((l) => /^emoji:\s*/.test(l));
        if (e >= 0) { p.emoji = lines[e].replace(/^emoji:\s*/, "").trim(); lines.splice(e, 1); }
        p.blurb = lines.join("\n").trim();
      } else if (/^cover\./.test(name)) {
        p.cover = { name, sha: f.sha };
      } else {
        const fm = /^(\d+)\.(\w+)$/.exec(name);
        if (!fm) continue;
        const fact = (p.facts[fm[1]] ||= { stem: fm[1] });
        if (fm[2] === "md") { fact.text = texts[f.path].trim(); fact.sha = f.sha; }
        else fact.audio = { name, sha: f.sha, size: f.size };
      }
    }
    const list = Object.values(pages)
      .map((p) => ({
        ...p,
        facts: Object.values(p.facts)
          .filter((f) => f.text !== undefined)
          .sort((a, b) => Number(a.stem) - Number(b.stem))
          .map((f) => ({ ...f, recording: recordings[`${p.number}/${f.stem}`] || null })),
      }))
      .sort((a, b) => a.number - b.number);
    return json({ head, pages: list, recordings });
  } catch (e) {
    return fail(502, e.message);
  }
}
