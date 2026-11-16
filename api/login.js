import { checkPassword, sessionCookie, clearCookie, json, fail } from "./_lib.js";

// POST {password} → sets the session cookie.  DELETE → logs out.
export async function POST(req) {
  if (!process.env.ADMIN_PASSWORD) return fail(503, "Dashboard isn't set up yet (no ADMIN_PASSWORD).");
  let password = "";
  try { ({ password } = await req.json()); } catch {}
  if (!checkPassword(password || "")) {
    await new Promise((r) => setTimeout(r, 1000)); // slow down guessing
    return fail(401, "That's not the password.");
  }
  return json({ ok: true }, 200, { "set-cookie": sessionCookie() });
}

export function DELETE() {
  return json({ ok: true }, 200, { "set-cookie": clearCookie() });
}
