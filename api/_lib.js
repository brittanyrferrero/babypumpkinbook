// Shared helpers for the dashboard API (files starting with "_" are not routes).
//
// The dashboard never touches the deployed site directly. Every save is a
// commit to the GitHub repo, and Vercel redeploys from that like any other
// push. Env vars (set in Vercel → Project → Settings → Environment Variables):
//
//   ADMIN_PASSWORD   the full dashboard password; also signs the login cookie
//   RECORDER_PASSWORD optional, the family password for /record (recordings only)
//   GITHUB_TOKEN     fine-grained token, this repo only, Contents: read & write
//   GITHUB_REPO      optional, default brittanyrferrero/babypumpkinbook
//   GITHUB_BRANCH    optional, default main

import { createHmac, timingSafeEqual } from "node:crypto";

export const REPO = process.env.GITHUB_REPO || "brittanyrferrero/babypumpkinbook";
export const BRANCH = process.env.GITHUB_BRANCH || "main";
const COOKIE = "pb_session";
const SESSION_DAYS = 30;

// ---------- responses ----------
export const json = (data, status = 200, headers = {}) =>
  new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json", "cache-control": "no-store", ...headers } });
export const fail = (status, error) => json({ error }, status);

// ---------- auth ----------
// Two passwords, two roles. ADMIN_PASSWORD opens the full dashboard (/admin).
// RECORDER_PASSWORD is the family password: it only opens /record, which can
// add a recording to a fact that doesn't have a person's recording yet.
// The role is inside the signed cookie, so it can't be changed by the browser.
function sign(exp, role) {
  return createHmac("sha256", process.env.ADMIN_PASSWORD).update(`pb-session:${exp}:${role}`).digest("base64url");
}
function safeEqual(a, b) {
  const x = Buffer.from(String(a)), y = Buffer.from(String(b));
  return x.length === y.length && timingSafeEqual(x, y);
}
// → "admin" | "recorder" | null
export function checkPassword(pw) {
  if (!pw) return null;
  if (process.env.ADMIN_PASSWORD && safeEqual(pw, process.env.ADMIN_PASSWORD)) return "admin";
  if (process.env.ADMIN_PASSWORD && process.env.RECORDER_PASSWORD && safeEqual(pw, process.env.RECORDER_PASSWORD)) return "recorder";
  return null;
}
export function sessionCookie(role) {
  const exp = Date.now() + SESSION_DAYS * 864e5;
  return `${COOKIE}=${exp}.${role}.${sign(exp, role)}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${SESSION_DAYS * 86400}`;
}
export const clearCookie = () => `${COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0`;

// The logged-in role ("admin" | "recorder"), or null.
export function sessionRole(req) {
  const m = new RegExp(`(?:^|;\\s*)${COOKIE}=(\\d+)\\.(admin|recorder)\\.([\\w-]+)`).exec(req.headers.get("cookie") || "");
  if (!m || Number(m[1]) < Date.now() || !safeEqual(m[3], sign(m[1], m[2]))) return null;
  return m[2];
}

// Returns an error Response if the request isn't allowed, else null.
// roles: which roles may call this route (default: admin only).
export function requireAuth(req, roles = ["admin"]) {
  if (!process.env.ADMIN_PASSWORD || !process.env.GITHUB_TOKEN) return fail(503, "Dashboard isn't set up yet (missing ADMIN_PASSWORD or GITHUB_TOKEN).");
  const role = sessionRole(req);
  if (!role) return fail(401, "Please log in.");
  if (!roles.includes(role)) return fail(403, "That password can't do this.");
  // Writes must carry a custom header, which a cross-site form can't send.
  if (req.method !== "GET" && req.headers.get("x-pb") !== "1") return fail(403, "Bad request.");
  return null;
}

// ---------- GitHub ----------
export async function gh(path, opts = {}) {
  const res = await fetch(`https://api.github.com/repos/${REPO}${path}`, {
    ...opts,
    headers: {
      authorization: `Bearer ${process.env.GITHUB_TOKEN}`,
      accept: "application/vnd.github+json",
      "x-github-api-version": "2022-11-28",
      "user-agent": "babypumpkinbook-dashboard",
      ...(opts.body ? { "content-type": "application/json" } : {}),
      ...opts.headers,
    },
  });
  if (!res.ok && !opts.raw) {
    const text = await res.text();
    const err = new Error(`GitHub ${res.status}: ${text.slice(0, 300)}`);
    err.status = res.status;
    throw err;
  }
  return opts.raw ? res : res.json();
}

// Only these files can be written from the dashboard: page text, fact text,
// fact audio and the page picture, inside a numbered content folder, plus the
// recordings list. Nothing that could change the site's code.
const ALLOWED = /^content\/(\d+-[a-z0-9-]+\/(page\.md|\d{2,3}\.(md|mp3|m4a|mp4|ogg|wav)|cover\.(jpg|jpeg|png|webp|gif))|recordings\.json)$/;
export const allowedPath = (p) => typeof p === "string" && ALLOWED.test(p);

// One commit with any mix of: { path, content (base64) }, { path, sha } (move/copy
// an existing blob), { path, delete: true }. Retries once if main moved under us.
// `changes` can also be an async function of the head commit sha, which is
// called again on retry, for changes that depend on what's currently in main.
export async function commit(changes, message) {
  for (let attempt = 0; ; attempt++) {
    const ref = await gh(`/git/ref/heads/${BRANCH}`);
    const head = ref.object.sha;
    const headCommit = await gh(`/git/commits/${head}`);
    const list = typeof changes === "function" ? await changes(head) : changes;
    const tree = [];
    for (const c of list) {
      if (c.delete) tree.push({ path: c.path, mode: "100644", type: "blob", sha: null });
      else if (c.sha) tree.push({ path: c.path, mode: "100644", type: "blob", sha: c.sha });
      else {
        const blob = await gh(`/git/blobs`, { method: "POST", body: JSON.stringify({ content: c.content, encoding: "base64" }) });
        tree.push({ path: c.path, mode: "100644", type: "blob", sha: blob.sha });
      }
    }
    const newTree = await gh(`/git/trees`, { method: "POST", body: JSON.stringify({ base_tree: headCommit.tree.sha, tree }) });
    const newCommit = await gh(`/git/commits`, { method: "POST", body: JSON.stringify({ message, tree: newTree.sha, parents: [head] }) });
    try {
      await gh(`/git/refs/heads/${BRANCH}`, { method: "PATCH", body: JSON.stringify({ sha: newCommit.sha, force: false }) });
      return newCommit.sha;
    } catch (e) {
      if (attempt >= 1 || e.status !== 422) throw e;
    }
  }
}
