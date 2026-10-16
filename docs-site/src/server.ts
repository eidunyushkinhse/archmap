// Сервер документации: отдаёт собранный сайт, держит авторский режим (скрытый вход /login,
// редактор /edit/, API правок) и пересобирает dist/ после каждой правки — своей через API
// или чужой на диске (git pull, правка в редакторе кода).
//   node src/server.ts                 — сервер (DOCS_PORT, по умолчанию 8800)
//   node src/server.ts --dev           — плюс перезагрузка открытых вкладок при пересборке
//   node src/server.ts --set-password  — задать пароль автора (хэш пишется в .env)
import { existsSync, mkdirSync, readdirSync, readFileSync, rmdirSync, statSync, unlinkSync, watch, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { basename, dirname, extname, join, normalize, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import {
  AUTHOR_COOKIE, SESSION_COOKIE, SESSION_TTL_S, hashPassword, issueToken, loadAuthConfig, parseCookies,
  RateLimiter, verifyPassword, verifyToken, type AuthConfig,
} from "./auth.ts";
import { makeReader } from "./content.ts";
import { fmNumber, fmString, splitFrontMatter } from "./frontmatter.ts";
import { createRenderer, DocsError, pageUrl } from "./markdown.ts";
import { CONTENT_DIR, DATA_DIR, DIST_DIR, PKG_DIR, THEME_DIR } from "./paths.ts";
import { renderEditor, renderLogin, SITE, type Assets } from "./render.ts";
import { fragmentUsage, prepareSite, writeStatic, type Prepared } from "./site.ts";
import type { FrontMatter, FrontMatterValue, NavItem, Site } from "./types.ts";

export interface ServerOptions {
  contentDir: string;
  themeDir: string;
  distDir: string;
  dataDir: string;
  port: number;
  host?: string;
  dev?: boolean;
  auth?: AuthConfig;
  trustProxy?: boolean;   // адрес клиента и схема — из X-Forwarded-* (за nginx)
  quiet?: boolean;
}

export interface RebuildResult {
  errors: string[];
  warnings: string[];
}

export interface DocsServer {
  server: Server;
  port: number;
  rebuild(): RebuildResult;
  close(): Promise<void>;
}

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
const IMAGE_EXT = new Set([".png", ".jpg", ".jpeg", ".webp", ".gif", ".svg"]);
const LIVE_RELOAD =
  "<script>(()=>{let s=null;setInterval(async()=>{try{const t=await(await fetch('/__stamp',{cache:'no-store'})).text();"
  + "if(s&&t!==s)location.reload();s=t;}catch{}},1000)})()</script>";

// Путь файла содержимого из запроса: только латиница, цифры, «-», «_», «/», без «..»
const FILE_RE = /^(?:[a-z0-9_-]+\/)*[a-z0-9_-]+\.md$/;
const SLUG_RE = /^[a-z0-9-]{1,60}$/;
const PARENT_RE = /^(?:[a-z0-9_-]+\/)*$/;

class HttpError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

interface TreeNode {
  file: string;
  url: string;
  title: string;
  description: string;
  kind: "home" | "guide" | "section" | "page";
  children: TreeNode[];
}

function navJson(items: NavItem[]): TreeNode[] {
  const out: TreeNode[] = [];
  for (const it of items) {
    if (it.kind === "page") {
      out.push({ file: it.page.file, url: it.page.url, title: it.page.title, description: it.page.description, kind: "page", children: [] });
    } else if (it.index) {
      out.push({ file: it.index.file, url: it.index.url, title: it.title, description: it.index.description, kind: "section", children: navJson(it.items) });
    } else {
      out.push(...navJson(it.items));
    }
  }
  return out;
}

function treeJson(site: Site): TreeNode[] {
  const home: TreeNode = { file: site.home.file, url: "/", title: SITE.homeLabel, description: site.home.description, kind: "home", children: [] };
  const guides = site.guides.map((g): TreeNode => ({
    file: g.index.file, url: g.index.url, title: g.title, description: g.description, kind: "guide", children: navJson(g.nav),
  }));
  const standalone = site.pages
    .filter((p) => p.guide === null && p !== site.home)
    .map((p): TreeNode => ({ file: p.file, url: p.url, title: p.title, description: p.description, kind: "page", children: [] }));
  return [home, ...guides, ...standalone];
}

function serializeFrontMatter(fm: FrontMatter): string {
  const order = ["title", "short", "order", "description"];
  const keys = [...order.filter((k) => k in fm), ...Object.keys(fm).filter((k) => !order.includes(k))];
  const lines = keys
    .filter((k) => fm[k] !== "" && fm[k] !== undefined)
    .map((k) => `${k}: ${String(fm[k]).replace(/\r?\n/g, " ")}`);
  return `---\n${lines.join("\n")}\n---\n`;
}

// Транслитерация названия в адрес: «Навигация по проекту» → navigatsiya-po-proektu
const TRANSLIT: Record<string, string> = {
  а: "a", б: "b", в: "v", г: "g", д: "d", е: "e", ё: "e", ж: "zh", з: "z", и: "i", й: "y", к: "k", л: "l", м: "m",
  н: "n", о: "o", п: "p", р: "r", с: "s", т: "t", у: "u", ф: "f", х: "h", ц: "ts", ч: "ch", ш: "sh", щ: "sch",
  ъ: "", ы: "y", ь: "", э: "e", ю: "yu", я: "ya",
};
export function slugFromTitle(title: string): string {
  const s = [...title.toLowerCase()].map((c) => TRANSLIT[c] ?? c).join("")
    .replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60).replace(/-+$/, "");
  return s || "page";
}

function readBody(req: IncomingMessage, limit: number): Promise<Buffer> {
  return new Promise((ok, fail) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size > limit) {
        fail(new HttpError(413, "слишком большое тело запроса"));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => ok(Buffer.concat(chunks)));
    req.on("error", fail);
  });
}

function json(res: ServerResponse, status: number, data: unknown): void {
  res.statusCode = status;
  res.setHeader("content-type", "application/json; charset=utf-8");
  res.setHeader("cache-control", "no-store");
  res.end(JSON.stringify(data));
}

function html(res: ServerResponse, status: number, body: string): void {
  res.statusCode = status;
  res.setHeader("content-type", "text/html; charset=utf-8");
  res.setHeader("cache-control", "no-store");
  res.end(body);
}

function cookie(name: string, value: string, maxAge: number, httpOnly: boolean, secure: boolean): string {
  return `${name}=${encodeURIComponent(value)}; Path=/; Max-Age=${maxAge}; SameSite=Lax${httpOnly ? "; HttpOnly" : ""}${secure ? "; Secure" : ""}`;
}

function safeNext(v: string | null): string {
  return v && v.startsWith("/") && !v.startsWith("//") ? v : "/edit/";
}

export async function startServer(opts: ServerOptions): Promise<DocsServer> {
  const auth = opts.auth ?? loadAuthConfig(opts.dataDir);
  const limiter = new RateLimiter(5, 15 * 60 * 1000);
  const log = (msg: string) => { if (!opts.quiet) console.log(msg); };
  let prepared: Prepared | null = null;
  let assets: Assets | null = null;
  let stamp = String(Date.now());

  const rebuild = (): RebuildResult => {
    try {
      const next = prepareSite(opts.contentDir);
      assets = writeStatic(next, opts.distDir, opts.contentDir, opts.themeDir);
      prepared = next;
      stamp = String(Date.now());
      return { errors: next.errors, warnings: next.warnings };
    } catch (e) {
      if (!(e instanceof DocsError)) throw e;
      return { errors: [e.message], warnings: [] };
    }
  };
  const first = rebuild();
  if (!prepared || !assets) throw new Error(`сайт не собрался: ${first.errors.join("; ")}`);
  for (const w of first.warnings) log(`предупреждение: ${w}`);
  for (const e of first.errors) log(`ошибка: ${e}`);

  // Пересборка по правке файлов на диске (редактор кода, git pull); правки через API
  // тоже попадают сюда — лишняя пересборка дешевле пропущенной
  let timer: NodeJS.Timeout | null = null;
  const schedule = () => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      const r = rebuild();
      for (const e of r.errors) log(`ошибка: ${e}`);
    }, 150);
  };
  const watchers = [opts.contentDir, opts.themeDir].map((d) => watch(d, { recursive: true }, schedule));

  const clientIp = (req: IncomingMessage): string => {
    const fwd = opts.trustProxy ? req.headers["x-forwarded-for"] : undefined;
    const first = Array.isArray(fwd) ? fwd[0] : fwd?.split(",")[0];
    return (first?.trim() || req.socket.remoteAddress) ?? "?";
  };
  const isSecure = (req: IncomingMessage): boolean => opts.trustProxy === true && req.headers["x-forwarded-proto"] === "https";
  const isAuthor = (req: IncomingMessage): boolean => verifyToken(auth.secret, parseCookies(req.headers.cookie)[SESSION_COOKIE]);
  const requireAuthor = (req: IncomingMessage): void => {
    if (!isAuthor(req)) throw new HttpError(401, "нужен вход автора");
  };
  const requireMutation = (req: IncomingMessage): void => {
    requireAuthor(req);
    if (req.headers["x-requested-with"] !== "docs") throw new HttpError(403, "запрос не из редактора");
  };
  const checkFile = (file: unknown): string => {
    if (typeof file !== "string" || !FILE_RE.test(file)) throw new HttpError(400, "недопустимый путь файла");
    return file;
  };
  const absFile = (file: string): string => join(opts.contentDir, file);
  const isFragment = (file: string): boolean => file.split("/").some((seg, i, arr) => i < arr.length - 1 && seg.startsWith("_"));
  const site = (): Site => {
    if (!prepared) throw new HttpError(503, "сайт не собран");
    return prepared.site;
  };

  // ── Статика ────────────────────────────────────────────────────────────────
  const serveStatic = (res: ServerResponse, pathname: string): void => {
    let file = join(opts.distDir, normalize(pathname));
    if (!file.startsWith(opts.distDir)) throw new HttpError(403, "запрещено");
    if (existsSync(file) && statSync(file).isDirectory()) {
      if (!pathname.endsWith("/")) {
        res.statusCode = 301;
        res.setHeader("location", `${pathname}/`);
        res.end();
        return;
      }
      file = join(file, "index.html");
    }
    let status = 200;
    if (!existsSync(file) || !statSync(file).isFile()) {
      // Картинки, на которые ещё нет ссылок (только что загружены), — из content/
      const fromContent = join(opts.contentDir, normalize(pathname));
      if (IMAGE_EXT.has(extname(pathname).toLowerCase()) && fromContent.startsWith(opts.contentDir) && existsSync(fromContent) && statSync(fromContent).isFile()) {
        file = fromContent;
      } else {
        status = 404;
        file = join(opts.distDir, "404.html");
        if (!existsSync(file)) {
          res.statusCode = 404;
          res.end("404");
          return;
        }
      }
    }
    const ext = extname(file);
    let body = readFileSync(file);
    if (ext === ".html" && opts.dev) body = Buffer.from(body.toString("utf8").replace("</body>", `${LIVE_RELOAD}</body>`));
    res.statusCode = status;
    res.setHeader("content-type", MIME[ext] ?? "application/octet-stream");
    res.setHeader("cache-control", ext === ".html" ? "no-cache" : "public, max-age=3600");
    res.setHeader("x-content-type-options", "nosniff");
    res.end(body);
  };

  // ── Вход и выход ───────────────────────────────────────────────────────────
  const loginPage = (req: IncomingMessage, res: ServerResponse, url: URL, error: string | null, status = 200): void => {
    if (!assets) throw new HttpError(503, "сайт не собран");
    if (isAuthor(req)) {
      res.statusCode = 303;
      res.setHeader("location", safeNext(url.searchParams.get("next")));
      res.end();
      return;
    }
    html(res, status, renderLogin(assets, { error, next: safeNext(url.searchParams.get("next")), configured: auth.passwordHash !== null }));
  };

  const login = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const form = new URLSearchParams((await readBody(req, 64 * 1024)).toString("utf8"));
    const next = safeNext(form.get("next"));
    const target = new URL(`/login?next=${encodeURIComponent(next)}`, "http://localhost");
    if (!auth.passwordHash) return loginPage(req, res, target, null, 403);
    const ip = clientIp(req);
    if (!limiter.hit(ip)) return loginPage(req, res, target, "Слишком много попыток — подождите 15 минут.", 429);
    if (!verifyPassword(form.get("password") ?? "", auth.passwordHash)) {
      log(`вход: неверный пароль с ${ip}`);
      return loginPage(req, res, target, "Неверный пароль.", 401);
    }
    limiter.reset(ip);
    const secure = isSecure(req);
    res.setHeader("set-cookie", [
      cookie(SESSION_COOKIE, issueToken(auth.secret), SESSION_TTL_S, true, secure),
      cookie(AUTHOR_COOKIE, "1", SESSION_TTL_S, false, secure),
    ]);
    res.statusCode = 303;
    res.setHeader("location", next);
    res.end();
    log(`вход автора с ${ip}`);
  };

  const logout = (req: IncomingMessage, res: ServerResponse): void => {
    const secure = isSecure(req);
    res.setHeader("set-cookie", [cookie(SESSION_COOKIE, "", 0, true, secure), cookie(AUTHOR_COOKIE, "", 0, false, secure)]);
    res.statusCode = 204;
    res.end();
  };

  // ── API редактора ──────────────────────────────────────────────────────────
  const readPage = (file: string) => {
    const abs = absFile(file);
    if (!existsSync(abs)) throw new HttpError(404, "файла нет");
    const { fm, body } = splitFrontMatter(readFileSync(abs, "utf8"));
    const { title: _t, short: _s, order: _o, description: _d, ...extra } = fm;
    const fragment = isFragment(file);
    return {
      file,
      isFragment: fragment,
      url: fragment ? null : pageUrl(file),
      title: fmString(fm, "title") ?? "",
      description: fmString(fm, "description") ?? "",
      order: fmNumber(fm, "order"),
      short: fmString(fm, "short") ?? "",
      extra,
      body,
      usedBy: fragment ? fragmentUsage(site(), opts.contentDir).find((u) => u.file === file)?.usedBy ?? [] : [],
    };
  };

  const savePage = (input: Record<string, unknown>): { url: string | null } & RebuildResult => {
    const file = checkFile(input.file);
    const abs = absFile(file);
    if (!existsSync(abs)) throw new HttpError(404, "файла нет — создайте страницу");
    const current = splitFrontMatter(readFileSync(abs, "utf8")).fm;
    const fm: FrontMatter = { ...current };
    const title = typeof input.title === "string" ? input.title.trim() : "";
    if (!isFragment(file) && !title) throw new HttpError(400, "название обязательно");
    const set = (k: string, v: unknown) => {
      if (v === undefined || v === null || v === "") delete fm[k];
      else fm[k] = v as FrontMatterValue;
    };
    set("title", title);
    set("description", typeof input.description === "string" ? input.description.trim() : "");
    set("order", typeof input.order === "number" && Number.isFinite(input.order) ? input.order : "");
    set("short", typeof input.short === "string" ? input.short.trim() : "");
    const body = typeof input.body === "string" ? input.body.replace(/\r\n/g, "\n").replace(/^\n+/, "").replace(/\s+$/, "") : "";
    const text = (Object.keys(fm).length ? `${serializeFrontMatter(fm)}\n` : "") + body + "\n";
    writeFileSync(abs, text);
    const r = rebuild();
    return { url: isFragment(file) ? null : pageUrl(file), ...r };
  };

  const createPage = (input: Record<string, unknown>): { file: string; url: string | null } & RebuildResult => {
    const kind = input.kind;
    const slug = typeof input.slug === "string" ? input.slug : "";
    if (!SLUG_RE.test(slug)) throw new HttpError(400, "адрес — латиница, цифры и дефис");
    const title = typeof input.title === "string" ? input.title.trim() : "";
    if (!title) throw new HttpError(400, "название обязательно");
    let file: string;
    if (kind === "fragment") {
      file = `_shared/${slug}.md`;
    } else {
      const parent = typeof input.parent === "string" ? input.parent : "";
      if (!PARENT_RE.test(parent) || parent.includes("..")) throw new HttpError(400, "недопустимая папка");
      if (parent && !existsSync(absFile(`${parent}index.md`))) throw new HttpError(400, "папка должна быть руководством или разделом с index.md");
      file = kind === "section" ? `${parent}${slug}/index.md` : `${parent}${slug}.md`;
    }
    const abs = absFile(file);
    if (existsSync(abs)) throw new HttpError(409, `уже есть: ${file}`);
    const fm: FrontMatter = { title };
    if (typeof input.description === "string" && input.description.trim()) fm.description = input.description.trim();
    if (typeof input.order === "number" && Number.isFinite(input.order)) fm.order = input.order;
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, kind === "fragment" ? `## ${title}\n\n` : `${serializeFrontMatter(fm)}\n`);
    const r = rebuild();
    return { file, url: kind === "fragment" ? null : pageUrl(file), ...r };
  };

  const deletePage = (file: string): RebuildResult => {
    if (file === "index.md") throw new HttpError(400, "главную страницу удалить нельзя");
    const abs = absFile(file);
    if (!existsSync(abs)) throw new HttpError(404, "файла нет");
    if (basename(file) === "index.md") {
      const dir = dirname(abs);
      const others = readdirSync(dir).filter((n) => n !== "index.md");
      if (others.length) throw new HttpError(409, "сначала удалите страницы внутри раздела");
    }
    unlinkSync(abs);
    const dir = dirname(abs);
    if (dir !== opts.contentDir && readdirSync(dir).length === 0) rmdirSync(dir);
    return rebuild();
  };

  // Предпросмотр: рендер текста в контексте файла и проверка ссылок по текущему сайту
  const preview = (input: Record<string, unknown>): { html: string; errors: string[] } => {
    const file = checkFile(input.file);
    const body = typeof input.body === "string" ? input.body : "";
    const title = typeof input.title === "string" ? input.title : "";
    const errors: string[] = [];
    try {
      const r = createRenderer(makeReader(opts.contentDir)).render(file, body, title);
      const s = site();
      for (const l of r.links) {
        const own = l.target === file;
        const target = own ? null : s.byFile.get(l.target);
        if (!own && !target) {
          errors.push(`ссылка на несуществующую страницу «${l.raw}»`);
          continue;
        }
        const headings = own ? r.headings : target?.render?.headings ?? [];
        if (l.hash && !headings.some((x) => x.id === l.hash)) errors.push(`якорь «#${l.hash}» не найден (${own ? "на этой странице" : l.target})`);
      }
      for (const a of r.assets) {
        if (!existsSync(absFile(a.target))) errors.push(`файл не найден — «${a.raw}»`);
      }
      return { html: r.html, errors };
    } catch (e) {
      if (!(e instanceof DocsError)) throw e;
      return { html: "", errors: [e.message] };
    }
  };

  const upload = async (req: IncomingMessage, url: URL): Promise<{ path: string; markdown: string }> => {
    const raw = basename(url.searchParams.get("name") ?? "image.png").toLowerCase();
    const ext = extname(raw);
    if (!IMAGE_EXT.has(ext)) throw new HttpError(400, "можно загружать png, jpg, webp, gif и svg");
    const stem = slugFromTitle(raw.slice(0, -ext.length)) || "image";
    const dir = join(opts.contentDir, "images");
    mkdirSync(dir, { recursive: true });
    let name = `${stem}${ext}`;
    for (let n = 2; existsSync(join(dir, name)); n++) name = `${stem}-${n}${ext}`;
    const data = await readBody(req, 8 * 1024 * 1024);
    if (!data.length) throw new HttpError(400, "пустой файл");
    writeFileSync(join(dir, name), data);
    return { path: `images/${name}`, markdown: `![Описание картинки](/images/${name} "Подпись")` };
  };

  const api = async (req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> => {
    const method = req.method ?? "GET";
    const route = `${method} ${url.pathname}`;
    if (route === "GET /api/me") return json(res, 200, { author: isAuthor(req) });
    requireAuthor(req);
    if (route === "GET /api/tree") {
      return json(res, 200, {
        tree: treeJson(site()),
        fragments: fragmentUsage(site(), opts.contentDir),
        errors: prepared?.errors ?? [],
        warnings: prepared?.warnings ?? [],
      });
    }
    if (route === "GET /api/page") return json(res, 200, readPage(checkFile(url.searchParams.get("file"))));
    if (method !== "GET") requireMutation(req);
    if (route === "PUT /api/page") return json(res, 200, savePage(JSON.parse((await readBody(req, 2 * 1024 * 1024)).toString("utf8"))));
    if (route === "POST /api/page") return json(res, 201, createPage(JSON.parse((await readBody(req, 64 * 1024)).toString("utf8"))));
    if (route === "DELETE /api/page") return json(res, 200, deletePage(checkFile(url.searchParams.get("file"))));
    if (route === "POST /api/preview") return json(res, 200, preview(JSON.parse((await readBody(req, 2 * 1024 * 1024)).toString("utf8"))));
    if (route === "POST /api/upload") return json(res, 201, await upload(req, url));
    throw new HttpError(404, "нет такого метода");
  };

  const handle = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const method = req.method ?? "GET";
    const pathname = decodeURIComponent(url.pathname);
    if (pathname === "/__stamp") {
      res.setHeader("content-type", "text/plain");
      res.setHeader("cache-control", "no-store");
      res.end(stamp);
      return;
    }
    if (pathname === "/login") return method === "POST" ? login(req, res) : loginPage(req, res, url, null);
    if (pathname === "/logout" && method === "POST") return logout(req, res);
    if (pathname.startsWith("/api/")) return api(req, res, url);
    if (pathname === "/edit" || pathname === "/edit/") {
      if (!isAuthor(req)) {
        res.statusCode = 302;
        res.setHeader("location", `/login?next=${encodeURIComponent(`/edit/${url.search}`)}`);
        res.end();
        return;
      }
      if (!assets) throw new HttpError(503, "сайт не собран");
      return html(res, 200, renderEditor(assets));
    }
    if (method !== "GET" && method !== "HEAD") throw new HttpError(405, "метод не поддерживается");
    serveStatic(res, pathname);
  };

  const server = createServer((req, res) => {
    handle(req, res).catch((e: unknown) => {
      const status = e instanceof HttpError ? e.status : e instanceof SyntaxError ? 400 : 500;
      const message = e instanceof Error ? e.message : String(e);
      if (status === 500) console.error(e);
      if (res.headersSent) {
        res.end();
        return;
      }
      if ((req.url ?? "").startsWith("/api/")) json(res, status, { error: message });
      else html(res, status, `<!doctype html><meta charset="utf-8"><title>${status}</title><p>${status}: ${message.replace(/</g, "&lt;")}</p>`);
    });
  });

  await new Promise<void>((ok) => server.listen(opts.port, opts.host ?? "127.0.0.1", ok));
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : opts.port;
  log(`Документация: http://${opts.host ?? "localhost"}:${port}/ — вход автора: /login${auth.passwordHash ? "" : " (пароль не задан: npm run password)"}`);
  return {
    server,
    port,
    rebuild,
    close: () => new Promise<void>((ok, fail) => {
      for (const w of watchers) w.close();
      if (timer) clearTimeout(timer);
      server.close((e) => (e ? fail(e) : ok()));
    }),
  };
}

// ── CLI ──────────────────────────────────────────────────────────────────────
function readHidden(prompt: string): Promise<string> {
  return new Promise((ok) => {
    process.stdout.write(prompt);
    const stdin = process.stdin;
    if (!stdin.isTTY) {
      let buf = "";
      stdin.setEncoding("utf8");
      stdin.on("data", (c: string) => { buf += c; });
      stdin.on("end", () => ok(buf.split(/\r?\n/)[0] ?? ""));
      return;
    }
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding("utf8");
    let value = "";
    const onData = (ch: string) => {
      for (const c of ch) {
        if (c === "\r" || c === "\n") {
          stdin.setRawMode(false);
          stdin.pause();
          stdin.off("data", onData);
          process.stdout.write("\n");
          ok(value);
          return;
        }
        if (c === "\u0003") process.exit(130);
        if (c === "\u007f" || c === "\b") value = value.slice(0, -1);
        else value += c;
      }
    };
    stdin.on("data", onData);
  });
}

async function setPassword(): Promise<void> {
  const a = await readHidden("Новый пароль автора: ");
  const b = await readHidden("Ещё раз: ");
  if (a.length < 8) { console.error("Пароль короче 8 символов."); process.exit(1); }
  if (a !== b) { console.error("Пароли не совпали."); process.exit(1); }
  const envPath = join(PKG_DIR, ".env");
  const lines = existsSync(envPath) ? readFileSync(envPath, "utf8").split(/\r?\n/).filter((l) => !l.startsWith("DOCS_AUTHOR_PASSWORD_HASH=") && !l.startsWith("DOCS_AUTHOR_PASSWORD=")) : [];
  while (lines.length && lines[lines.length - 1] === "") lines.pop();
  lines.push(`DOCS_AUTHOR_PASSWORD_HASH=${hashPassword(a)}`);
  writeFileSync(envPath, `${lines.join("\n")}\n`, { mode: 0o600 });
  console.log(`Пароль сохранён в ${envPath} (хэш scrypt). Перезапустите сервер.`);
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      dev: { type: "boolean", default: false },
      port: { type: "string" },
      host: { type: "string" },
      "set-password": { type: "boolean", default: false },
    },
  });
  const envPath = join(PKG_DIR, ".env");
  if (existsSync(envPath)) process.loadEnvFile(envPath);
  if (values["set-password"]) return setPassword();
  await startServer({
    contentDir: CONTENT_DIR,
    themeDir: THEME_DIR,
    distDir: DIST_DIR,
    dataDir: DATA_DIR,
    port: Number(values.port ?? process.env.DOCS_PORT ?? 8800),
    host: values.host ?? process.env.DOCS_HOST ?? "127.0.0.1",
    dev: values.dev,
    trustProxy: process.env.DOCS_TRUST_PROXY === "true",
  });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((e: unknown) => {
    console.error(e instanceof Error ? e.message : e);
    process.exit(1);
  });
}
