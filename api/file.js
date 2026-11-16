import { requireAuth, gh, fail } from "./_lib.js";

// GET ?sha=<blob sha>&name=<file name> → the file's bytes, so the dashboard
// can play a recording or show a picture before the site has redeployed.
const TYPES = { mp3: "audio/mpeg", m4a: "audio/mp4", mp4: "audio/mp4", ogg: "audio/ogg", wav: "audio/wav",
  jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png", webp: "image/webp", gif: "image/gif" };

export async function GET(req) {
  const denied = requireAuth(req, ["admin", "recorder"]);
  if (denied) return denied;
  const url = new URL(req.url);
  const sha = url.searchParams.get("sha") || "";
  const ext = (url.searchParams.get("name") || "").split(".").pop().toLowerCase();
  if (!/^[0-9a-f]{40}$/.test(sha) || !TYPES[ext]) return fail(400, "Bad file.");
  try {
    const res = await gh(`/git/blobs/${sha}`, { raw: true, headers: { accept: "application/vnd.github.raw" } });
    if (!res.ok) return fail(404, "Not found.");
    return new Response(res.body, {
      headers: { "content-type": TYPES[ext], "cache-control": "private, max-age=31536000, immutable" },
    });
  } catch (e) {
    return fail(502, e.message);
  }
}
