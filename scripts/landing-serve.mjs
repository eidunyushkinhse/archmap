// Локальный просмотр лендинга: статический сервер с поддержкой Range.
// `python3 -m http.server` запросы Range не понимает, и браузер не может перемотать ролик:
// щелчок по подписи сцены под роликом первого экрана возвращает его в начало. На сервере
// (nginx) Range есть, поэтому смотреть лендинг локально нужно через этот скрипт.
//
//   node scripts/landing-serve.mjs <папка лендинга> [порт]     # по умолчанию порт 8791
//
// Слушает только 127.0.0.1, отдаёт файлы без кэша (правка видна по F5).
import { createServer } from "node:http";
import { createReadStream, statSync } from "node:fs";
import { extname, join, normalize, resolve, sep } from "node:path";

const ROOT = resolve(process.argv[2] ?? ".");
const PORT = Number(process.argv[3] ?? 8791);
const TYPES = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8", ".json": "application/json", ".svg": "image/svg+xml", ".png": "image/png",
  ".jpg": "image/jpeg", ".webp": "image/webp", ".mp4": "video/mp4", ".webm": "video/webm", ".woff2": "font/woff2",
  ".txt": "text/plain; charset=utf-8", ".wasm": "application/wasm",
};

createServer((req, res) => {
  const send = (code, text) => { res.writeHead(code, { "Content-Type": "text/plain; charset=utf-8" }); res.end(text); };
  if (req.method !== "GET" && req.method !== "HEAD") return send(405, "Только чтение");
  let path;
  try { path = decodeURIComponent(new URL(req.url, "http://x").pathname); } catch { return send(400, "Плохой адрес"); }
  let file = normalize(join(ROOT, path));
  if (file !== ROOT && !file.startsWith(ROOT + sep)) return send(403, "Вне папки лендинга");
  let st;
  try {
    st = statSync(file);
    if (st.isDirectory()) { file = join(file, "index.html"); st = statSync(file); }
  } catch { return send(404, "Нет такого файла"); }
  const head = {
    "Content-Type": TYPES[extname(file).toLowerCase()] ?? "application/octet-stream",
    "Accept-Ranges": "bytes", "Cache-Control": "no-store",
  };
  const m = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range ?? "");
  let start = 0, end = st.size - 1, code = 200;
  if (m && (m[1] || m[2])) {
    if (m[1]) { start = Number(m[1]); if (m[2]) end = Math.min(end, Number(m[2])); } else start = Math.max(0, st.size - Number(m[2]));
    if (start > end || start >= st.size) { res.writeHead(416, { "Content-Range": `bytes */${st.size}` }); return res.end(); }
    code = 206;
    head["Content-Range"] = `bytes ${start}-${end}/${st.size}`;
  }
  head["Content-Length"] = end - start + 1;
  res.writeHead(code, head);
  if (req.method === "HEAD") return res.end();
  createReadStream(file, { start, end }).on("error", () => res.destroy()).pipe(res);
}).listen(PORT, "127.0.0.1", () => console.log(`Лендинг из ${ROOT}: http://localhost:${PORT}/  (Ctrl+C — остановить)`));
