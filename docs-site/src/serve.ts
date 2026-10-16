// Dev-сервер: отдаёт dist/, пересобирает по правке файлов и перезагружает открытые вкладки
// (страница раз в секунду спрашивает /__stamp и перезагружается, когда он сменился).
import { existsSync, readFileSync, statSync, watch } from "node:fs";
import { createServer } from "node:http";
import { extname, join, normalize } from "node:path";

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
  ".ico": "image/x-icon",
  ".txt": "text/plain; charset=utf-8",
  ".pdf": "application/pdf",
  ".woff2": "font/woff2",
};

const LIVE_RELOAD =
  "<script>(()=>{let s=null;setInterval(async()=>{try{const t=await(await fetch('/__stamp',{cache:'no-store'})).text();"
  + "if(s&&t!==s)location.reload();s=t;}catch{}},1000)})()</script>";

export function serve(outDir: string, port: number, rebuild: () => void, watchDirs: string[]): void {
  let stamp = String(Date.now());
  let timer: NodeJS.Timeout | null = null;
  const schedule = () => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      rebuild();
      stamp = String(Date.now());
    }, 150);
  };
  for (const d of watchDirs) watch(d, { recursive: true }, schedule);

  const server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    if (url.pathname === "/__stamp") {
      res.setHeader("content-type", "text/plain");
      res.setHeader("cache-control", "no-store");
      res.end(stamp);
      return;
    }
    const pathname = decodeURIComponent(url.pathname);
    let file = join(outDir, normalize(pathname));
    if (!file.startsWith(outDir)) {
      res.statusCode = 403;
      res.end();
      return;
    }
    if (existsSync(file) && statSync(file).isDirectory()) {
      if (!pathname.endsWith("/")) {
        res.statusCode = 301;
        res.setHeader("location", `${pathname}/`);
        res.end();
        return;
      }
      file = join(file, "index.html");
    }
    if (!existsSync(file) || !statSync(file).isFile()) {
      res.statusCode = 404;
      file = join(outDir, "404.html");
      if (!existsSync(file)) {
        res.end("404");
        return;
      }
    }
    const ext = extname(file);
    let body = readFileSync(file);
    if (ext === ".html") body = Buffer.from(body.toString("utf8").replace("</body>", `${LIVE_RELOAD}</body>`));
    res.setHeader("content-type", MIME[ext] ?? "application/octet-stream");
    res.setHeader("cache-control", "no-store");
    res.end(body);
  });
  server.listen(port, "127.0.0.1", () => {
    console.log(`Документация: http://localhost:${port}/ (слежу за content/ и theme/, Ctrl+C — выход)`);
  });
}
