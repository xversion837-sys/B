const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

function loadEnv() {
  try {
    const text = fs.readFileSync(path.join(process.cwd(), ".env"), "utf8");
    for (const line of text.split("\n")) {
      const t = line.trim();
      if (!t || t.startsWith("#")) continue;
      const i = t.indexOf("=");
      if (i === -1) continue;
      const key = t.slice(0, i).trim();
      const val = t.slice(i + 1).trim().replace(/^["']|["']$/g, "");
      if (!process.env[key]) process.env[key] = val;
    }
  } catch (_) {}
}

function filePath(name) {
  return path.join(process.cwd(), name);
}

function readFile(name) {
  try {
    return fs.readFileSync(filePath(name), "utf8").trim();
  } catch (_) {
    return "";
  }
}

function writeFile(name, value) {
  fs.writeFileSync(filePath(name), (value || "").trim() + "\n", "utf8");
}

function envPassword() {
  try {
    const text = fs.readFileSync(filePath(".env"), "utf8");
    for (const line of text.split("\n")) {
      const t = line.trim();
      if (!t.startsWith("ADMIN_PASSWORD=")) continue;
      return t.slice(t.indexOf("=") + 1).trim().replace(/^["']|["']$/g, "");
    }
  } catch (_) {}
  return process.env.ADMIN_PASSWORD || "admin123";
}

function hashPassword(plain) {
  const salt = crypto.randomBytes(16).toString("hex");
  const hash = crypto.scryptSync(plain, salt, 32).toString("hex");
  return "v1$" + salt + "$" + hash;
}

function verifyStoredPassword(plain, stored) {
  if (!stored || !plain) return false;
  if (stored.startsWith("v1$")) {
    const parts = stored.split("$");
    if (parts.length !== 3) return false;
    const next = crypto.scryptSync(plain, parts[1], 32).toString("hex");
    const a = Buffer.from(next, "hex");
    const b = Buffer.from(parts[2], "hex");
    if (a.length !== b.length) return false;
    return crypto.timingSafeEqual(a, b);
  }
  const left = Buffer.from(String(plain));
  const right = Buffer.from(String(stored));
  if (left.length !== right.length) return false;
  return crypto.timingSafeEqual(left, right);
}

function siteRepo() {
  return (
    process.env.GITHUB_SITE_REPO ||
    readFile("github.site.repo") ||
    (process.env.VERCEL_GIT_REPO_OWNER && process.env.VERCEL_GIT_REPO_SLUG
      ? process.env.VERCEL_GIT_REPO_OWNER + "/" + process.env.VERCEL_GIT_REPO_SLUG
      : "") ||
    process.env.GITHUB_REPO ||
    ""
  );
}

function suggestedRepo() {
  return readFile("github.repo") || "";
}

async function resolveApkRepoFromToken(token) {
  if (!token) return "";
  const user = await githubUser(token);
  if (!user) return "";
  const apk = user.login + "/" + apkRepoSlug(user.login);
  if (await githubRepoOk(token, apk)) return apk;
  return "";
}

async function ensureApkRepo(ctx, cookies, body) {
  const site = siteRepo();
  const explicit = String((body && body.repo) || "").trim();
  if (explicit) {
    ctx.repo = explicit;
    return;
  }
  if (cookies.gh_repo) {
    ctx.repo = cookies.gh_repo;
    return;
  }
  const file = readFile("github.repo");
  if (file) {
    ctx.repo = file;
    return;
  }
  if (ctx.repo && ctx.repo !== site) return;
  if (ctx.token) {
    const apk = await resolveApkRepoFromToken(ctx.token);
    if (apk) {
      ctx.repo = apk;
      return;
    }
  }
  if (!ctx.repo) ctx.repo = site;
}

function apkRepoSlug(login) {
  return String(login || "user")
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, "") + "-apk-host";
}

const ctx = { token: "", repo: "", branch: "main" };

function parseCookies(req) {
  const raw = (req && req.headers && (req.headers.cookie || req.headers.Cookie)) || "";
  const out = {};
  String(raw)
    .split(";")
    .forEach((part) => {
      const i = part.indexOf("=");
      if (i === -1) return;
      out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
    });
  return out;
}

function fillCtx(req, body) {
  const cookies = parseCookies(req);
  body = body || {};
  const connectToken =
    body.action === "github-connect" ||
    body.action === "github-verify" ||
    body.action === "github-setup"
      ? String(body.token || "").trim()
      : "";
  const fromBody = String(body.githubToken || "").trim();
  ctx.token =
    connectToken ||
    cookies.gh_token ||
    fromBody ||
    process.env.GITHUB_TOKEN ||
    readFile("github.token") ||
    "";
  ctx.repo =
    String(body.repo || "").trim() ||
    cookies.gh_repo ||
    readFile("github.repo") ||
    "";
  ctx.branch =
    process.env.GITHUB_BRANCH || process.env.VERCEL_GIT_COMMIT_REF || "main";
}

function repoInfo() {
  return { token: ctx.token, repo: ctx.repo, branch: ctx.branch };
}

function setGithubCookies(res, token, repo) {
  const secure = process.env.VERCEL === "1" || process.env.NODE_ENV === "production";
  const maxAge = token ? "31536000" : "0";
  const tokenParts = [
    "gh_token=" + encodeURIComponent(token || ""),
    "HttpOnly",
    "Path=/",
    "SameSite=Lax",
    "Max-Age=" + maxAge
  ];
  if (secure) tokenParts.push("Secure");
  const repoParts = [
    "gh_repo=" + encodeURIComponent(repo || ""),
    "HttpOnly",
    "Path=/",
    "SameSite=Lax",
    "Max-Age=" + (repo ? maxAge : "0")
  ];
  if (secure) repoParts.push("Secure");
  res.setHeader("Set-Cookie", [tokenParts.join("; "), repoParts.join("; ")]);
}

function setEnvKey(text, key, val) {
  if (new RegExp("^" + key + "=", "m").test(text)) {
    return text.replace(new RegExp("^" + key + "=.*$", "m"), key + "=" + val);
  }
  return text + (text && !text.endsWith("\n") ? "\n" : "") + key + "=" + val + "\n";
}

function saveGithubToken(token, repo, site) {
  try {
    writeFile("github.token", token);
    if (repo) writeFile("github.repo", repo);
    if (site) writeFile("github.site.repo", site);
  } catch (_) {}
  process.env.GITHUB_TOKEN = token;
  if (repo) process.env.GITHUB_REPO = repo;
  if (site) process.env.GITHUB_SITE_REPO = site;
  ctx.token = token;
  if (repo) ctx.repo = repo;
  try {
    let text = "";
    try {
      text = fs.readFileSync(filePath(".env"), "utf8");
    } catch (_) {}
    text = setEnvKey(text, "GITHUB_TOKEN", token);
    if (repo) text = setEnvKey(text, "GITHUB_REPO", repo);
    fs.writeFileSync(filePath(".env"), text.endsWith("\n") ? text : text + "\n", "utf8");
  } catch (_) {}
}

async function savePortfolioConfig(token, apkRepo, site) {
  if (!token || !apkRepo) return;
  const branch = repoInfo().branch || "main";
  let sha = null;
  try {
    const res = await fetch(
      "https://api.github.com/repos/" + apkRepo + "/contents/portfolio.config.json?ref=" + branch,
      { headers: { Authorization: "Bearer " + token, "User-Agent": "app-admin" } }
    );
    if (res.ok) sha = (await res.json()).sha;
  } catch (_) {}
  const content = JSON.stringify({ apkRepo, siteRepo: site || "", version: 1 }, null, 2) + "\n";
  await fetch("https://api.github.com/repos/" + apkRepo + "/contents/portfolio.config.json", {
    method: "PUT",
    headers: {
      Authorization: "Bearer " + token,
      "Content-Type": "application/json",
      "User-Agent": "app-admin"
    },
    body: JSON.stringify({
      message: "Save portfolio config",
      content: Buffer.from(content).toString("base64"),
      branch,
      sha: sha || undefined
    })
  });
}

async function githubUser(token) {
  const res = await fetch("https://api.github.com/user", {
    headers: { Authorization: "Bearer " + token, "User-Agent": "app-admin" }
  });
  if (!res.ok) return null;
  return res.json();
}

async function githubRepoOk(token, repo) {
  const res = await fetch("https://api.github.com/repos/" + repo, {
    headers: { Authorization: "Bearer " + token, "User-Agent": "app-admin" }
  });
  return res.ok;
}

async function githubCreateRepo(token, name) {
  const res = await fetch("https://api.github.com/user/repos", {
    method: "POST",
    headers: {
      Authorization: "Bearer " + token,
      "Content-Type": "application/json",
      "User-Agent": "app-admin"
    },
    body: JSON.stringify({
      name,
      description: "Public APK host for download portfolio",
      private: false,
      auto_init: true
    })
  });
  if (res.ok) return { ok: true };
  let err = {};
  try {
    err = await res.json();
  } catch (_) {}
  if (res.status === 422) {
    return { ok: false, exists: true, error: err.message || "Repo name already exists" };
  }
  return {
    ok: false,
    error:
      (err.message || "Could not create repo") +
      (res.status === 403 ? ". Token needs repo scope and permission to create repositories." : "")
  };
}

async function ensureUploadsFolder(token, repo) {
  const branch = repoInfo().branch || "main";
  const res = await fetch(
    "https://api.github.com/repos/" + repo + "/contents/uploads/.gitkeep?ref=" + branch,
    { headers: { Authorization: "Bearer " + token, "User-Agent": "app-admin" } }
  );
  if (res.ok) return;
  const put = await fetch("https://api.github.com/repos/" + repo + "/contents/uploads/.gitkeep", {
    method: "PUT",
    headers: {
      Authorization: "Bearer " + token,
      "Content-Type": "application/json",
      "User-Agent": "app-admin"
    },
    body: JSON.stringify({
      message: "Create uploads folder",
      content: Buffer.from("# APK uploads\n").toString("base64"),
      branch
    })
  });
  if (!put.ok) {
    const t = await put.text();
    throw new Error("Could not create uploads folder: " + t.slice(0, 100));
  }
}

async function githubGet(file) {
  const { token, repo, branch } = repoInfo();
  if (!token || !repo) return null;
  const res = await fetch(
    "https://api.github.com/repos/" + repo + "/contents/" + file + "?ref=" + branch,
    { headers: { Authorization: "Bearer " + token, "User-Agent": "app-admin" } }
  );
  if (!res.ok) return null;
  const data = await res.json();
  return {
    content: Buffer.from(data.content || "", "base64").toString("utf8").trim(),
    sha: data.sha
  };
}

async function githubPut(file, content, sha, asBase64) {
  const { token, repo, branch } = repoInfo();
  const encoded = asBase64
    ? String(content).replace(/\s/g, "")
    : Buffer.from((content || "").trim() + "\n").toString("base64");
  const res = await fetch("https://api.github.com/repos/" + repo + "/contents/" + file, {
    method: "PUT",
    headers: {
      Authorization: "Bearer " + token,
      "Content-Type": "application/json",
      "User-Agent": "app-admin"
    },
    body: JSON.stringify({
      message: "Update " + file,
      content: encoded,
      branch,
      sha: sha || undefined
    })
  });
  if (!res.ok) {
    const err = await res.text();
    throw new Error("GitHub save failed: " + err);
  }
}

async function githubSha(file) {
  const { token, repo, branch } = repoInfo();
  if (!token || !repo) return null;
  const res = await fetch(
    "https://api.github.com/repos/" + repo + "/contents/" + file + "?ref=" + branch,
    { headers: { Authorization: "Bearer " + token, "User-Agent": "app-admin" } }
  );
  if (!res.ok) return null;
  const data = await res.json();
  return data.sha || null;
}

function safeFileName(name) {
  const base = path.basename(String(name || "app.apk"));
  const clean = base.replace(/[^a-zA-Z0-9._-]/g, "_").replace(/_+/g, "_");
  return clean || "app.apk";
}

async function uploadApp(filename, fileBase64) {
  const clean = safeFileName(filename);
  const rel = "uploads/" + clean;
  const buf = Buffer.from(String(fileBase64 || "").replace(/\s/g, ""), "base64");
  if (!buf.length) throw new Error("Empty file");
  if (buf.length > 20 * 1024 * 1024) {
    throw new Error("File too big. Max 20MB.");
  }

  const dir = filePath("uploads");
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  try {
    fs.writeFileSync(filePath(rel), buf);
  } catch (_) {}

  const { token, repo, branch } = repoInfo();
  let rawUrl = "";
  if (token && repo) {
    const sha = await githubSha(rel);
    await githubPut(rel, String(fileBase64 || "").replace(/\s/g, ""), sha, true);
    rawUrl =
      "https://github.com/" +
      repo +
      "/raw/refs/heads/" +
      branch +
      "/" +
      encodeURI(rel);
  }

  return {
    filename: clean,
    rawUrl: rawUrl || "",
    siteUrl: "/uploads/" + clean
  };
}

async function fetchPublicRawFrom(repo, file) {
  const branch =
    (ctx && ctx.branch) ||
    process.env.GITHUB_BRANCH ||
    process.env.VERCEL_GIT_COMMIT_REF ||
    "main";
  if (!repo) return "";
  const urls = [
    "https://raw.githubusercontent.com/" + repo + "/" + branch + "/" + file + "?t=" + Date.now(),
    "https://github.com/" + repo + "/raw/refs/heads/" + branch + "/" + encodeURI(file) + "?t=" + Date.now()
  ];
  for (const url of urls) {
    try {
      const res = await fetch(url, { cache: "no-store", redirect: "follow" });
      if (res.ok) return (await res.text()).trim();
    } catch (_) {}
  }
  return "";
}

async function fetchPublicRaw(file) {
  const repos = [...new Set([suggestedRepo(), siteRepo()].filter(Boolean))];
  for (const repo of repos) {
    const text = await fetchPublicRawFrom(repo, file);
    if (text && !text.startsWith("<")) return text;
  }
  return "";
}

async function loadPasswordRecord() {
  const token =
    ctx.token || readFile("github.token") || process.env.GITHUB_TOKEN || "";
  const repos = [...new Set([readFile("github.repo"), siteRepo()].filter(Boolean))];
  const branch = ctx.branch || process.env.GITHUB_BRANCH || "main";

  if (token) {
    for (const repo of repos) {
      try {
        const res = await fetch(
          "https://api.github.com/repos/" + repo + "/contents/admin.hash?ref=" + branch,
          { headers: { Authorization: "Bearer " + token, "User-Agent": "app-admin" } }
        );
        if (res.ok) {
          const data = await res.json();
          const text = Buffer.from(data.content || "", "base64").toString("utf8").trim();
          if (text) return text;
        }
      } catch (_) {}
    }
  }

  for (const repo of repos) {
    const raw = await fetchPublicRawFrom(repo, "admin.hash");
    if (raw && !raw.startsWith("<")) return raw;
  }

  return readFile("admin.hash") || readFile("admin.secret") || envPassword();
}

async function checkPassword(plain) {
  return verifyStoredPassword(plain, await loadPasswordRecord());
}

async function savePassword(next) {
  const record = hashPassword(next);
  try {
    writeFile("admin.hash", record);
  } catch (_) {}
  try {
    writeFile("admin.secret", next);
  } catch (_) {}
  process.env.ADMIN_PASSWORD = next;

  try {
    let text = "";
    try {
      text = fs.readFileSync(filePath(".env"), "utf8");
    } catch (_) {}
    text = setEnvKey(text || "", "ADMIN_PASSWORD", next);
    fs.writeFileSync(filePath(".env"), text.endsWith("\n") ? text : text + "\n", "utf8");
  } catch (_) {}

  const { token, repo } = repoInfo();
  if (token && repo) {
    const cur = await githubGet("admin.hash");
    await githubPut("admin.hash", record, cur && cur.sha);
    return;
  }
  if (process.env.VERCEL) {
    throw new Error("Connect GitHub at /install before changing the password.");
  }
}

async function githubDelete(file) {
  const { token, repo, branch } = repoInfo();
  if (!token || !repo) throw new Error("Connect GitHub first at /install");
  const cur = await githubGet(file);
  if (!cur || !cur.sha) throw new Error("File not found");
  const res = await fetch("https://api.github.com/repos/" + repo + "/contents/" + file, {
    method: "DELETE",
    headers: {
      Authorization: "Bearer " + token,
      "Content-Type": "application/json",
      "User-Agent": "app-admin"
    },
    body: JSON.stringify({
      message: "Delete " + file,
      sha: cur.sha,
      branch
    })
  });
  if (!res.ok) {
    const err = await res.text();
    throw new Error("Delete failed: " + err.slice(0, 120));
  }
}

async function listUploads() {
  const { token, repo, branch } = repoInfo();
  if (!token || !repo) return [];
  const res = await fetch(
    "https://api.github.com/repos/" + repo + "/contents/uploads?ref=" + branch,
    { headers: { Authorization: "Bearer " + token, "User-Agent": "app-admin" } }
  );
  if (!res.ok) return [];
  const data = await res.json();
  if (!Array.isArray(data)) return [];
  return data
    .filter((item) => item.type === "file" && /\.apk$/i.test(item.name))
    .map((item) => ({
      name: item.name,
      path: item.path,
      url:
        "https://github.com/" +
        repo +
        "/raw/refs/heads/" +
        branch +
        "/" +
        encodeURI(item.path)
    }));
}

async function getSettings() {
  const fromGitName = await githubGet("name.txt");
  const fromGitLink = await githubGet("app.txt");
  let name = fromGitName && fromGitName.content ? fromGitName.content : "";
  let download = fromGitLink && fromGitLink.content ? fromGitLink.content : "";
  if (!name) name = await fetchPublicRaw("name.txt");
  if (!download) download = await fetchPublicRaw("app.txt");
  if (!name) name = readFile("name.txt");
  if (!download) download = readFile("app.txt");
  return { name, download };
}

async function saveSettings(name, download) {
  const { token, repo } = repoInfo();

  if (token && repo) {
    const curName = await githubGet("name.txt");
    const curLink = await githubGet("app.txt");
    if (typeof name === "string") {
      await githubPut("name.txt", name, curName && curName.sha);
    }
    if (typeof download === "string") {
      await githubPut("app.txt", download, curLink && curLink.sha);
    }
    return;
  }

  try {
    if (typeof name === "string") writeFile("name.txt", name);
    if (typeof download === "string") writeFile("app.txt", download);
  } catch (err) {
    throw new Error(
      "Cannot save locally on Vercel. Connect GitHub at /install first."
    );
  }
}

function send(res, status, data) {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json");
  res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate");
  res.end(JSON.stringify(data));
}

function bodyOf(req) {
  if (req.body && typeof req.body === "object") return req.body;
  if (typeof req.body === "string") {
    try {
      return JSON.parse(req.body);
    } catch (_) {
      return {};
    }
  }
  return {};
}

async function handler(req, res) {
  loadEnv();
  const body = req.method === "POST" ? bodyOf(req) : {};
  fillCtx(req, body);
  await ensureApkRepo(ctx, parseCookies(req), body);

  if (req.method === "GET") {
    return send(res, 200, await getSettings());
  }

  if (req.method !== "POST") {
    return send(res, 405, { error: "Method not allowed" });
  }

  if (body.action === "public-github-check") {
    const { token, repo } = repoInfo();
    if (!token) {
      return send(res, 200, { connected: false, repo: suggestedRepo() });
    }
    const user = await githubUser(token);
    if (!user) {
      return send(res, 200, { connected: false, repo: suggestedRepo() });
    }
    if (token && ctx.repo) setGithubCookies(res, token, ctx.repo);
    return send(res, 200, {
      connected: true,
      user: user.login,
      repo: ctx.repo || repo || suggestedRepo()
    });
  }

  if (!(await checkPassword(body.password || ""))) {
    return send(res, 401, { error: "Wrong password" });
  }

  if (body.action === "login") {
    const { token, repo } = repoInfo();
    if (token && ctx.repo) setGithubCookies(res, token, ctx.repo);
    return send(res, 200, {
      ok: true,
      github: { connected: Boolean(token), repo: ctx.repo || repo || suggestedRepo() },
      githubToken: token || undefined,
      ...(await getSettings())
    });
  }

  if (body.action === "github-status") {
    const { token, repo } = repoInfo();
    if (!token) {
      return send(res, 200, { connected: false, repo: suggestedRepo() });
    }
    const user = await githubUser(token);
    if (!user) {
      return send(res, 200, { connected: false, repo: suggestedRepo(), error: "Token invalid" });
    }
    if (token && ctx.repo) setGithubCookies(res, token, ctx.repo);
    return send(res, 200, {
      connected: true,
      user: user.login,
      repo: ctx.repo || repo || suggestedRepo(),
      branch: repoInfo().branch || "main"
    });
  }

  if (body.action === "github-verify") {
    const token = String(body.token || "").trim();
    if (!token) return send(res, 400, { error: "GitHub token empty" });
    const user = await githubUser(token);
    if (!user) return send(res, 401, { error: "GitHub token invalid or expired" });
    const site = siteRepo();
    const siteRepoOk = site ? await githubRepoOk(token, site) : true;
    const apkSlug = apkRepoSlug(user.login);
    const apkRepo = user.login + "/" + apkSlug;
    const apkExists = await githubRepoOk(token, apkRepo);
    return send(res, 200, {
      ok: true,
      user: user.login,
      siteRepo: site,
      siteRepoOk,
      apkRepo,
      apkExists
    });
  }

  if (body.action === "github-setup") {
    const token = String(body.token || "").trim();
    if (!token) return send(res, 400, { error: "GitHub token empty" });
    const user = await githubUser(token);
    if (!user) return send(res, 401, { error: "GitHub token invalid or expired" });
    const site = siteRepo();
    if (site && !(await githubRepoOk(token, site))) {
      return send(res, 400, {
        error: "Token cannot access site repo " + site + ". Create token with repo scope."
      });
    }
    const apkSlug = apkRepoSlug(user.login);
    const apkRepo = user.login + "/" + apkSlug;
    let created = false;
    if (!(await githubRepoOk(token, apkRepo))) {
      const made = await githubCreateRepo(token, apkSlug);
      if (!made.ok) {
        if (made.exists && (await githubRepoOk(token, apkRepo))) {
          created = false;
        } else {
          return send(res, 400, { error: made.error || "Could not create APK host repo" });
        }
      } else {
        created = true;
        await new Promise((r) => setTimeout(r, created ? 1500 : 0));
      }
    }
    ctx.token = token;
    ctx.repo = apkRepo;
    try {
      await ensureUploadsFolder(token, apkRepo);
    } catch (err) {
      return send(res, 500, { error: err.message || "Uploads folder setup failed" });
    }
    try {
      saveGithubToken(token, apkRepo, site);
      await savePortfolioConfig(token, apkRepo, site);
    } catch (_) {}
    setGithubCookies(res, token, apkRepo);
    return send(res, 200, {
      ok: true,
      user: user.login,
      siteRepo: site,
      apkRepo,
      created
    });
  }

  if (body.action === "github-connect") {
    const token = String(body.token || "").trim();
    const repo = String(body.repo || suggestedRepo() || "").trim();
    if (!token) return send(res, 400, { error: "GitHub token empty" });
    const user = await githubUser(token);
    if (!user) return send(res, 401, { error: "GitHub token invalid" });
    if (repo) {
      const ok = await githubRepoOk(token, repo);
      if (!ok) return send(res, 400, { error: "This token cannot access " + repo });
    }
    try {
      saveGithubToken(token, repo, siteRepo());
    } catch (_) {}
    setGithubCookies(res, token, repo);
    return send(res, 200, { ok: true, user: user.login, repo });
  }

  if (body.action === "github-disconnect") {
    try {
      saveGithubToken("", "");
    } catch (_) {}
    setGithubCookies(res, "", "");
    ctx.token = "";
    return send(res, 200, { ok: true, connected: false });
  }

  if (body.action === "change-password") {
    const next = String(body.newPassword || "").trim();
    const confirm = String(body.confirmPassword || "").trim();
    if (next.length < 4) {
      return send(res, 400, { error: "Password at least 4 characters" });
    }
    if (next !== confirm) {
      return send(res, 400, { error: "Passwords do not match" });
    }
    try {
      await savePassword(next);
    } catch (err) {
      throw new Error(err.message || "Password save failed.");
    }
    return send(res, 200, { ok: true });
  }

  if (body.action === "list-uploads") {
    return send(res, 200, { uploads: await listUploads() });
  }

  if (body.action === "delete-upload") {
    const file = String(body.file || "").trim();
    if (!file || !file.startsWith("uploads/")) {
      return send(res, 400, { error: "Invalid file" });
    }
    await githubDelete(file);
    return send(res, 200, { ok: true, uploads: await listUploads() });
  }

  if (body.action === "upload-app") {
    const uploaded = await uploadApp(body.filename, body.fileBase64);
    if (!uploaded.rawUrl) {
      uploaded.rawUrl = uploaded.siteUrl;
      return send(res, 200, {
        ok: true,
        ...uploaded,
        warning: "GitHub not connected. Set up GitHub at /install."
      });
    }
    return send(res, 200, { ok: true, ...uploaded });
  }

  const current = await getSettings();
  let name = current.name;
  let download = current.download;

  if (body.action === "delete-name") name = "";
  else if (body.action === "delete-link") download = "";
  else if (body.action === "delete-all") {
    name = "";
    download = "";
  } else {
    if (typeof body.name === "string") name = body.name;
    if (typeof body.download === "string") download = body.download;
  }

  await saveSettings(name, download);
  return send(res, 200, { ok: true, name, download });
}

module.exports = async (req, res) => {
  try {
    await handler(req, res);
  } catch (err) {
    send(res, 500, { error: err.message || "Save failed" });
  }
};

module.exports.getSettings = getSettings;
