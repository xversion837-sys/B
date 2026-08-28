const http = require("http");
const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const handler = require("../api/admin");

try {
  const text = fs.readFileSync(path.join(ROOT, ".env"), "utf8");
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

function jsonRes(res) {
  const wrapped = {
    statusCode: 200,
    setHeader: res.setHeader.bind(res),
    end: (body) => {
      res.statusCode = wrapped.statusCode || 200;
      res.end(body);
    }
  };
  return wrapped;
}

const server = http.createServer((req, res) => {
  const url = decodeURIComponent((req.url || "/").split("?")[0]);

  if (
    url === "/.env" ||
    url.startsWith("/.env.") ||
    url === "/admin.secret" ||
    url === "/github.token" ||
    url === "/github.repo" ||
    url === "/.gitignore"
  ) {
    res.writeHead(404);
    return res.end("Not found");
  }

  if (url === "/api/admin") {
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
      handler(req, jsonRes(res));
    });
    return;
  }

  let file = url === "/" ? "/index.html" : url;
  if (file === "/admin" || file === "/admin/") file = "/admin/index.html";
  if (file === "/install" || file === "/install/") file = "/install.html";

  const full = path.normalize(path.join(ROOT, file));
  if (!full.startsWith(ROOT)) {
    res.writeHead(403);
    return res.end("Forbidden");
  }

  fs.readFile(full, (err, data) => {
    if (err) {
      res.writeHead(404);
      return res.end("Not found");
    }
    res.writeHead(200, {
      "Content-Type": MIME[path.extname(full)] || "application/octet-stream"
    });
    res.end(data);
  });
});

const port = process.env.PORT || 3000;
server.listen(port, () => {
  console.log("Open http://localhost:" + port);
  console.log("Admin http://localhost:" + port + "/admin");
  console.log("Install http://localhost:" + port + "/install");
});
