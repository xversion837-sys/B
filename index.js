const fs = require("fs");
const path = require("path");

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
  ".css": "text/css",
  ".js": "text/javascript",
  ".json": "application/json",
  ".apk": "application/vnd.android.package-archive",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".svg": "image/svg+xml"
};

const BLOCKED = new Set([
  "/admin.hash",
  "/.env",
  "/admin.secret",
  "/github.token",
  "/github.repo",
  "/.gitignore",
  "/.vercelignore",
  "/package.json",
  "/vercel.json",
  "/index.js"
]);

function send(res, status, body, type) {
  res.statusCode = status;
  res.setHeader("Content-Type", type || "text/plain; charset=utf-8");
  res.end(body);
}

function readLocal(name) {
  try {
    return fs.readFileSync(path.join(__dirname, name), "utf8").trim();
  } catch (_) {
    return "";
  }
}

async function liveSettings() {
  try {
    const admin = require("./api/admin");
    if (admin.getSettings) return await admin.getSettings();
  } catch (_) {}
  return { name: readLocal("name.txt"), download: readLocal("app.txt") };
}

function injectHome(html, settings) {
  const name = settings.name || "App";
  const download = settings.download || "";
  const about =
    "Get instant loans with flexible repayment options. " +
    name +
    " makes borrowing easy, safe, and transparent with just a few taps.";
  const safe = JSON.stringify({ name, download }).replace(/</g, "\\u003c");
  return html
    .replace(/<title>.*?<\/title>/, "<title>" + name + "</title>")
    .replace('id="appName"></h1>', 'id="appName">' + name + "</h1>")
    .replace('id="aboutText">Get instant loans with flexible repayment options.</p>', 'id="aboutText">' + about + "</p>")
    .replace("</head>", '<script>window.__SITE__=' + safe + ";</script></head>");
}

module.exports = async (req, res) => {
  const url = decodeURIComponent((req.url || "/").split("?")[0]);

  if (url === "/api/admin") {
    const handler = require("./api/admin");
    if (req.body !== undefined || req.method === "GET") {
      return handler(req, res);
    }
    let raw = "";
    req.on("data", (c) => {
      raw += c;
    });
    req.on("end", () => {
      try {
        req.body = raw ? JSON.parse(raw) : {};
      } catch (_) {
        req.body = {};
      }
      handler(req, res);
    });
    return;
  }

  if (BLOCKED.has(url) || url.startsWith("/.env.") || url.startsWith("/scripts/")) {
    return send(res, 404, "Not found");
  }

  let file = url === "/" ? "/index.html" : url;
  if (file === "/admin" || file === "/admin/") file = "/admin/index.html";
  if (file === "/install" || file === "/install/") file = "/install.html";

  const full = path.normalize(path.join(__dirname, file));
  if (!full.startsWith(__dirname)) {
    return send(res, 403, "Forbidden");
  }

  if (file === "/index.html") {
    try {
      const html = fs.readFileSync(full, "utf8");
      const settings = await liveSettings();
      res.setHeader("Cache-Control", "no-store");
      return send(res, 200, injectHome(html, settings), MIME[".html"]);
    } catch (_) {
      return send(res, 404, "Not found");
    }
  }

  fs.readFile(full, (err, data) => {
    if (err) return send(res, 404, "Not found");
    send(res, 200, data, MIME[path.extname(full)] || "application/octet-stream");
  });
};
