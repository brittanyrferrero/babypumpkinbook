import { requireAuth, allowedPath, commit, json, fail } from "./_lib.js";

// POST { message, changes: [{path, content?|sha?|delete?}] } → one commit to main.
// Vercel sees the push and redeploys the site about a minute later.
export async function POST(req) {
  const denied = requireAuth(req);
  if (denied) return denied;
  let body;
  try { body = await req.json(); } catch { return fail(400, "Bad request."); }
  const { message, changes } = body || {};
  if (!Array.isArray(changes) || !changes.length || changes.length > 200) return fail(400, "Nothing to save.");
  for (const c of changes) {
    if (!allowedPath(c.path)) return fail(400, `Can't write ${c.path}`);
    const kinds = [c.delete === true, typeof c.sha === "string", typeof c.content === "string"].filter(Boolean).length;
    if (kinds !== 1) return fail(400, `Bad change for ${c.path}`);
    if (c.sha && !/^[0-9a-f]{40}$/.test(c.sha)) return fail(400, `Bad change for ${c.path}`);
  }
  const msg = `${String(message || "Dashboard edit").replace(/\s+/g, " ").slice(0, 120)}\n\nSaved from the dashboard.`;
  try {
    const sha = await commit(changes, msg);
    return json({ sha });
  } catch (e) {
    return fail(502, e.message);
  }
}
