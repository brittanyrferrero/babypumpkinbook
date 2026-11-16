import { requireAuth, gh, json, fail } from "./_lib.js";

// GET ?sha=<commit> → "pending" | "success" | "failure", from the status
// Vercel posts on each commit, so the dashboard can say when a save is live.
export async function GET(req) {
  const denied = requireAuth(req, ["admin", "recorder"]);
  if (denied) return denied;
  const sha = new URL(req.url).searchParams.get("sha") || "";
  if (!/^[0-9a-f]{40}$/.test(sha)) return fail(400, "Bad sha.");
  try {
    const { statuses } = await gh(`/commits/${sha}/status`);
    const vercel = statuses.find((s) => /vercel/i.test(s.context));
    const state = !vercel ? "pending" : vercel.state === "success" ? "success" : vercel.state === "pending" ? "pending" : "failure";
    return json({ state });
  } catch (e) {
    return fail(502, e.message);
  }
}
