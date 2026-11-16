import { requireAuth, gh, fail } from "./_lib.js";

// GET ?sha=<blob sha>&name=<file name> → the file's bytes, so the dashboard
// can play a recording or show a picture before the site has redeployed.
const TYPES = { mp3: "audio/mpeg", m4a: "audio/mp4", mp4: "audio/mp4", ogg: "audio/ogg", wav: "audio/wav",
  jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png", webp: "image/webp", gif: "image/gif" };

export async function GET(req) {
  const denied = requireAuth(req);
  if (denied) return denied;
  const url = new URL(req.url);
  const sha = url.searchParams.get("sha") || "";
  const ext = (url.searchParams.get("name") || "").split(".").pop().toLowerCase();
  if (!/^[0-9a-f]{40}$/.test(sha) || !TYPES[ext]) return fail(400, "Bad file.");
  try {
    const res = await gh(`/git/blobs/${sha}`, { raw: true, headers: { accept: "application/vnd.github.raw" } });
    if (!res.ok) return fail(404, "Not found.");
    // Safari only plays audio from a server that answers byte-range requests
    // with a 206 and a length, so read the whole file and slice it.
    const bytes = new Uint8Array(await res.arrayBuffer());
    const headers = { "content-type": TYPES[ext], "cache-control": "private, max-age=31536000, immutable", "accept-ranges": "bytes" };
    const m = /^bytes=(\d*)-(\d*)$/.exec(req.headers.get("range") || "");
    if (m && (m[1] || m[2])) {
      const size = bytes.length;
      let start = m[1] ? Number(m[1]) : Math.max(0, size - Number(m[2]));
      let end = m[1] && m[2] ? Math.min(Number(m[2]), size - 1) : size - 1;
      if (start >= size || start > end)
        return new Response(null, { status: 416, headers: { "content-range": `bytes */${size}` } });
      return new Response(bytes.slice(start, end + 1), {
        status: 206,
        headers: { ...headers, "content-range": `bytes ${start}-${end}/${size}`, "content-length": String(end - start + 1) },
      });
    }
    return new Response(bytes, { headers: { ...headers, "content-length": String(bytes.length) } });
  } catch (e) {
    return fail(502, e.message);
  }
}
