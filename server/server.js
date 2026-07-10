/* ============================================================
   MoneyFlow sync server — single file, zero dependencies.

   Run it with:            node server/server.js
   Change the port with:   PORT=3000 node server/server.js

   It serves the app itself AND a small API that gives each user
   an account (username + password) and a private, encrypted copy
   of their data:

   - Passwords are hashed with scrypt (salted) — never stored.
   - Each user's data is encrypted at rest with AES-256-GCM,
     using a key derived from a server secret generated on
     first run (server/data/secret.key — keep it, back it up).
   - Sessions are random tokens in an HttpOnly cookie.

   Everything lives in server/data/ (gitignored).
   ============================================================ */

const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const PORT = process.env.PORT || 8080;
const ROOT = path.join(__dirname, "..");
const DATA_DIR = path.join(__dirname, "data");
const USERS_FILE = path.join(DATA_DIR, "users.json");
const SESSIONS_FILE = path.join(DATA_DIR, "sessions.json");
const SECRET_FILE = path.join(DATA_DIR, "secret.key");

const USERNAME_RE = /^[A-Za-z0-9]{3,16}$/;
const PASSWORD_RE = /^[A-Za-z0-9]{6,32}$/;
const SESSION_DAYS = 30;
const MAX_BODY = 4 * 1024 * 1024; // 4 MB per user is plenty for years of entries

/* ---------------- storage ---------------- */

fs.mkdirSync(DATA_DIR, { recursive: true });

if (!fs.existsSync(SECRET_FILE)) {
  fs.writeFileSync(SECRET_FILE, crypto.randomBytes(32).toString("hex"), { mode: 0o600 });
  console.log("Generated new server secret (server/data/secret.key) — back this file up!");
}
const SECRET = fs.readFileSync(SECRET_FILE, "utf8").trim();

const loadJSON = (file, fallback) => {
  try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return fallback; }
};
const saveJSON = (file, obj) => fs.writeFileSync(file, JSON.stringify(obj), { mode: 0o600 });

const users = loadJSON(USERS_FILE, {});          // {username: {salt, hash, createdAt}}
const sessions = loadJSON(SESSIONS_FILE, {});    // {token: {username, expires}}
const loginFails = new Map();                    // username -> {count, until}

/* ---------------- crypto helpers ---------------- */

function hashPassword(password, salt) {
  return crypto.scryptSync(password, salt, 64).toString("hex");
}

function dataKey(username) {
  // per-user encryption key derived from the server secret
  return crypto.scryptSync(SECRET, "moneyflow-data:" + username, 32);
}

function userDataFile(username) {
  return path.join(DATA_DIR, "store-" + username.toLowerCase() + ".enc");
}

function saveUserData(username, jsonString) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", dataKey(username), iv);
  const ct = Buffer.concat([cipher.update(jsonString, "utf8"), cipher.final()]);
  saveJSON(userDataFile(username), {
    iv: iv.toString("base64"),
    tag: cipher.getAuthTag().toString("base64"),
    ct: ct.toString("base64")
  });
}

function loadUserData(username) {
  const file = userDataFile(username);
  if (!fs.existsSync(file)) return null;
  try {
    const { iv, tag, ct } = JSON.parse(fs.readFileSync(file, "utf8"));
    const decipher = crypto.createDecipheriv("aes-256-gcm", dataKey(username), Buffer.from(iv, "base64"));
    decipher.setAuthTag(Buffer.from(tag, "base64"));
    return Buffer.concat([decipher.update(Buffer.from(ct, "base64")), decipher.final()]).toString("utf8");
  } catch (e) {
    console.error("Could not decrypt data for " + username + ":", e.message);
    return null;
  }
}

/* ---------------- http helpers ---------------- */

function send(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on("data", c => {
      size += c.length;
      if (size > MAX_BODY) { reject(new Error("too large")); req.destroy(); return; }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function parseCookies(req) {
  const out = {};
  (req.headers.cookie || "").split(";").forEach(p => {
    const i = p.indexOf("=");
    if (i > 0) out[p.slice(0, i).trim()] = p.slice(i + 1).trim();
  });
  return out;
}

function isSecure(req) {
  return req.headers["x-forwarded-proto"] === "https" || !!req.socket.encrypted;
}

function setSession(res, req, username) {
  const token = crypto.randomBytes(32).toString("hex");
  sessions[token] = { username, expires: Date.now() + SESSION_DAYS * 864e5 };
  saveJSON(SESSIONS_FILE, sessions);
  res.setHeader("Set-Cookie",
    `mfsession=${token}; HttpOnly; Path=/; Max-Age=${SESSION_DAYS * 86400}; SameSite=Lax` +
    (isSecure(req) ? "; Secure" : ""));
  return token;
}

function currentUser(req) {
  const token = parseCookies(req).mfsession;
  const s = token && sessions[token];
  if (!s) return null;
  if (s.expires < Date.now()) { delete sessions[token]; saveJSON(SESSIONS_FILE, sessions); return null; }
  return s.username;
}

/* ---------------- api ---------------- */

async function handleApi(req, res, pathname) {
  if (pathname === "/api/ping") return send(res, 200, { ok: true });

  if (pathname === "/api/register" && req.method === "POST") {
    let body;
    try { body = JSON.parse(await readBody(req)); } catch { return send(res, 400, { error: "Bad request" }); }
    const username = String(body.username || "");
    const password = String(body.password || "");
    if (!USERNAME_RE.test(username))
      return send(res, 400, { error: "Username must be 3–16 letters or numbers (no special characters)." });
    if (!PASSWORD_RE.test(password) || !/[A-Za-z]/.test(password) || !/[0-9]/.test(password))
      return send(res, 400, { error: "Password must be 6–32 letters and numbers, with at least one of each." });
    const key = username.toLowerCase();
    if (Object.keys(users).some(u => u.toLowerCase() === key))
      return send(res, 409, { error: "That username is already taken." });
    const salt = crypto.randomBytes(16).toString("hex");
    users[username] = { salt, hash: hashPassword(password, salt), createdAt: new Date().toISOString() };
    saveJSON(USERS_FILE, users);
    setSession(res, req, username);
    console.log(`[${new Date().toISOString()}] new account: ${username}`);
    return send(res, 200, { username });
  }

  if (pathname === "/api/login" && req.method === "POST") {
    let body;
    try { body = JSON.parse(await readBody(req)); } catch { return send(res, 400, { error: "Bad request" }); }
    const username = Object.keys(users).find(u => u.toLowerCase() === String(body.username || "").toLowerCase());
    const fails = loginFails.get(String(body.username || "").toLowerCase());
    if (fails && fails.count >= 5 && Date.now() < fails.until)
      return send(res, 429, { error: "Too many failed attempts — try again in a few minutes." });
    const u = username && users[username];
    const ok = u && crypto.timingSafeEqual(
      Buffer.from(u.hash, "hex"),
      Buffer.from(hashPassword(String(body.password || ""), u.salt), "hex"));
    if (!ok) {
      const k = String(body.username || "").toLowerCase();
      const f = loginFails.get(k) || { count: 0, until: 0 };
      f.count += 1;
      f.until = Date.now() + 10 * 60e3;
      loginFails.set(k, f);
      await new Promise(r => setTimeout(r, 600)); // slow down guessing
      return send(res, 401, { error: "Wrong username or password." });
    }
    loginFails.delete(username.toLowerCase());
    setSession(res, req, username);
    return send(res, 200, { username });
  }

  if (pathname === "/api/logout" && req.method === "POST") {
    const token = parseCookies(req).mfsession;
    if (token) { delete sessions[token]; saveJSON(SESSIONS_FILE, sessions); }
    res.setHeader("Set-Cookie", "mfsession=; HttpOnly; Path=/; Max-Age=0; SameSite=Lax");
    return send(res, 200, { ok: true });
  }

  const username = currentUser(req);
  if (!username) return send(res, 401, { error: "Not signed in" });

  if (pathname === "/api/me") return send(res, 200, { username });

  if (pathname === "/api/data" && req.method === "GET") {
    const data = loadUserData(username);
    res.writeHead(200, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
    return res.end(data === null ? "null" : data);
  }

  if (pathname === "/api/data" && req.method === "PUT") {
    let raw;
    try { raw = await readBody(req); JSON.parse(raw); } catch { return send(res, 400, { error: "Bad data" }); }
    saveUserData(username, raw);
    return send(res, 200, { ok: true, savedAt: new Date().toISOString() });
  }

  return send(res, 404, { error: "Not found" });
}

/* ---------------- static files ---------------- */

const MIME = {
  ".html": "text/html; charset=utf-8", ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8", ".json": "application/json",
  ".webmanifest": "application/manifest+json", ".svg": "image/svg+xml",
  ".png": "image/png", ".ico": "image/x-icon", ".md": "text/markdown; charset=utf-8",
  ".txt": "text/plain; charset=utf-8"
};

function serveStatic(req, res, pathname) {
  let rel;
  try { rel = decodeURIComponent(pathname); } catch { rel = "/"; }
  if (rel.endsWith("/")) rel += "index.html";
  const file = path.normalize(path.join(ROOT, rel));
  // never serve the server directory (secrets + user data) or git internals
  if (!file.startsWith(ROOT + path.sep) ||
      file.startsWith(path.join(ROOT, "server") + path.sep) ||
      file.includes(path.sep + ".git")) {
    res.writeHead(404); return res.end("Not found");
  }
  fs.readFile(file, (err, buf) => {
    if (err) { res.writeHead(404); return res.end("Not found"); }
    res.writeHead(200, {
      "Content-Type": MIME[path.extname(file).toLowerCase()] || "application/octet-stream",
      "Cache-Control": "no-cache"
    });
    res.end(buf);
  });
}

/* ---------------- server ---------------- */

http.createServer(async (req, res) => {
  const pathname = new URL(req.url, "http://x").pathname;
  try {
    if (pathname.startsWith("/api/")) return await handleApi(req, res, pathname);
    if (req.method !== "GET" && req.method !== "HEAD") { res.writeHead(405); return res.end(); }
    return serveStatic(req, res, pathname);
  } catch (e) {
    console.error(e);
    try { send(res, 500, { error: "Server error" }); } catch { /* already sent */ }
  }
}).listen(PORT, () => {
  console.log(`MoneyFlow is running:  http://localhost:${PORT}`);
  console.log(`User data directory:   ${DATA_DIR}`);
});
