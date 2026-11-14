import { existsSync } from "node:fs";
import { resolve, sep } from "node:path";

const DIST_DIR = resolve(import.meta.dir, "../apps/web/dist");
const PORT = Number(process.env.PORT ?? 3000);
const HOST = process.env.HOST ?? "0.0.0.0";

const MIME_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".mjs": "application/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".svg": "image/svg+xml",
  ".bin": "application/octet-stream",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
  ".txt": "text/plain; charset=utf-8",
};

function getMimeType(filePath: string): string {
  const dot = filePath.lastIndexOf(".");
  if (dot < 0) return "application/octet-stream";
  const ext = filePath.slice(dot).toLowerCase();
  return MIME_TYPES[ext] ?? "application/octet-stream";
}

function getCacheControl(urlPath: string): string {
  if (urlPath === "/sw.js" || urlPath === "/index.html" || urlPath === "/") {
    return "no-cache";
  }
  if (urlPath === "/data/site-meta.json" || urlPath === "/data/site-weather.json") {
    return "no-cache";
  }
  if (urlPath.startsWith("/assets/")) {
    return "public, max-age=31536000, immutable";
  }
  if (urlPath.startsWith("/data/")) {
    return "public, max-age=86400";
  }
  return "public, max-age=3600";
}

function resolveDistFile(pathname: string): string | null {
  let decoded: string;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    return null;
  }
  const relPath = decoded === "/" ? "index.html" : decoded.replace(/^\/+/, "");
  const fullPath = resolve(DIST_DIR, relPath);
  if (fullPath !== DIST_DIR && !fullPath.startsWith(`${DIST_DIR}${sep}`)) {
    return null;
  }
  return fullPath;
}

if (!existsSync(resolve(DIST_DIR, "index.html"))) {
  console.error("Missing apps/web/dist/index.html. Run `bun run build` first.");
  process.exit(1);
}

const server = Bun.serve({
  hostname: HOST,
  port: PORT,
  async fetch(req) {
    if (req.method !== "GET" && req.method !== "HEAD") {
      return new Response("Method Not Allowed", { status: 405 });
    }

    const url = new URL(req.url);
    const targetPath = resolveDistFile(url.pathname);
    if (!targetPath) {
      return new Response("Forbidden", { status: 403 });
    }

    const file = Bun.file(targetPath);
    if (await file.exists()) {
      return new Response(req.method === "HEAD" ? null : file, {
        headers: {
          "Content-Type": getMimeType(targetPath),
          "Cache-Control": getCacheControl(url.pathname),
          "X-Content-Type-Options": "nosniff",
        },
      });
    }

    // Never return SPA index.html for missing binary/data/asset requests
    if (url.pathname.startsWith("/assets/") || url.pathname.startsWith("/data/")) {
      return new Response("Not Found", { status: 404 });
    }

    const fallback = Bun.file(resolve(DIST_DIR, "index.html"));
    return new Response(req.method === "HEAD" ? null : fallback, {
      headers: {
        "Content-Type": "text/html; charset=utf-8",
        "Cache-Control": "no-cache",
        "X-Content-Type-Options": "nosniff",
      },
    });
  },
});

console.log(`Static Mars Mission Planner listening on http://${HOST}:${server.port}`);
