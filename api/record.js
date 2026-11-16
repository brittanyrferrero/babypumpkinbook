import { requireAuth, gh, commit, json, fail } from "./_lib.js";

// POST { page, stem, by, audio (base64 mp3) } → one commit that adds a
// person's recording to a fact. This is the only write the family password
// can make: it can't change any text, and it can't replace a recording that
// a person already made (only an AI clip, which a person's recording beats).
const AUDIO = /^(\d{2,3})\.(mp3|m4a|mp4|ogg|wav)$/;

export async function POST(req) {
  const denied = requireAuth(req, ["admin", "recorder"]);
  if (denied) return denied;
  let body;
  try { body = await req.json(); } catch { return fail(400, "Bad request."); }
  const page = Number(body?.page);
  const stem = String(body?.stem || "");
  const by = String(body?.by || "").replace(/\s+/g, " ").trim().slice(0, 40);
  const audio = String(body?.audio || "");
  if (!Number.isInteger(page) || page < 1 || !/^\d{2,3}$/.test(stem)) return fail(400, "Bad fact.");
  if (!by) return fail(400, "Please add your name.");
  if (!audio || audio.length > 4_000_000 || !/^[A-Za-z0-9+/]+=*$/.test(audio)) return fail(400, "That recording is too long. Please keep it under 3 minutes.");
  const bytes = Buffer.from(audio, "base64");
  const isMp3 = (bytes[0] === 0x49 && bytes[1] === 0x44 && bytes[2] === 0x33) || (bytes[0] === 0xff && (bytes[1] & 0xe0) === 0xe0);
  if (bytes.length < 1000 || !isMp3) return fail(400, "That doesn't look like a recording.");

  try {
    const sha = await commit(async (head) => {
      const { tree } = await gh(`/git/trees/${head}?recursive=1`);
      const inPage = tree.filter((t) => t.type === "blob" && new RegExp(`^content/${page}-[^/]+/[^/]+$`).test(t.path));
      const factMd = inPage.find((t) => t.path.endsWith(`/${stem}.md`));
      if (!factMd) throw Object.assign(new Error("That fact isn't there any more."), { mine: 404 });
      const folder = factMd.path.split("/")[1];

      const recFile = tree.find((t) => t.path === "content/recordings.json");
      let recordings = {};
      if (recFile) {
        const b = await gh(`/git/blobs/${recFile.sha}`);
        try { recordings = JSON.parse(Buffer.from(b.content, "base64").toString("utf8")); } catch {}
      }
      const key = `${page}/${stem}`;
      const audioFiles = inPage.filter((t) => { const m = AUDIO.exec(t.path.split("/").pop()); return m && m[1] === stem; });
      // A person's recording is either listed in recordings.json or a non-mp3 file dropped in by hand.
      const human = recordings[key] || audioFiles.some((t) => !t.path.endsWith(".mp3"));
      if (human) throw Object.assign(new Error("Someone has already recorded this fact."), { mine: 409 });

      recordings[key] = { by, at: new Date().toISOString().slice(0, 10) };
      const sorted = Object.fromEntries(Object.keys(recordings).sort((a, b) => a.localeCompare(b, undefined, { numeric: true })).map((k) => [k, recordings[k]]));
      return [
        { path: `content/${folder}/${stem}.mp3`, content: audio },
        { path: "content/recordings.json", content: Buffer.from(JSON.stringify(sorted, null, 2) + "\n").toString("base64") },
      ];
    }, `Page ${page}: recording for fact ${stem} by ${by}\n\nRecorded on /record.`);
    return json({ sha });
  } catch (e) {
    if (e.mine) return fail(e.mine, e.message);
    return fail(502, e.message);
  }
}
