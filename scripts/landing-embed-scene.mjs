// Снимок сцены для живой схемы лендинга (frontend/src/embed): граф уровня так, как его
// отдаёт бэкенд, плюс составы всех контейнеров проекта — их холст догружает при
// раскрытии на месте. Сборка живой схемы (npm run build:embed) берёт снимок из
// frontend/src/embed/scene.gen.ts и работает без сервера.
//
// Запуск (dev-стек поднят через ./dev.sh):
//   node scripts/landing-embed-scene.mjs                        # страница «Сервиса заказов»
//   node scripts/landing-embed-scene.mjs --focus "Сервис оплаты" # страница другого объекта
//   node scripts/landing-embed-scene.mjs --root                 # корневой уровень проекта
//   node scripts/landing-embed-scene.mjs --positions all        # позиции вида целиком (по умолчанию locals)
//   node scripts/landing-embed-scene.mjs --project "Имя"        # другой проект (по умолчанию «… v2»)
//   node scripts/landing-embed-scene.mjs --out путь.ts          # другой файл генерата
// Учётка — ARCHMAP_USERNAME/ARCHMAP_PASSWORD из окружения, иначе из mcp/.env
// (учётка демо-проекта). Скрипт делает только GET-запросы: БД не меняется.
//
// Позиции (--positions): locals — только у объектов самого уровня; гостей и детей рамок
// раскладывает движок при показе. Сохранённый вид страницы обычно снят с раскрытыми
// рамками: гость стоит за краем раскрытой рамки, и свёрнутая схема выходит вдвое шире,
// а на ширине лендинга холст упирается в минимальный масштаб. all — вид как есть,
// none — всё раскладывает движок (как после «Переразложить»).
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const BACKEND = process.env.ARCHMAP_BACKEND ?? "http://localhost:8000";

const args = process.argv.slice(2);
const argOf = (n) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : undefined; };
const PROJECT_NAME = argOf("--project") ?? "Маркетплейс «Ярмарка» v2";
const FOCUS_NAME = args.includes("--root") ? null : (argOf("--focus") ?? "Сервис заказов");
const POSITIONS = argOf("--positions") ?? "locals";
if (!["all", "locals", "none"].includes(POSITIONS)) throw new Error(`--positions: all | locals | none, а не «${POSITIONS}»`);
const OUT = resolve(argOf("--out") ?? join(ROOT, "frontend/src/embed/scene.gen.ts"));

function credentials() {
  let user = process.env.ARCHMAP_USERNAME;
  let pass = process.env.ARCHMAP_PASSWORD;
  const envFile = join(ROOT, "mcp/.env");
  if ((!user || !pass) && existsSync(envFile)) {
    for (const line of readFileSync(envFile, "utf8").split("\n")) {
      const m = line.match(/^\s*([A-Z_]+)\s*=\s*(.*?)\s*$/);
      if (!m) continue;
      const v = m[2].replace(/^["']|["']$/g, "");
      if (m[1] === "ARCHMAP_USERNAME" && !user) user = v;
      if (m[1] === "ARCHMAP_PASSWORD" && !pass) pass = v;
    }
  }
  if (!user || !pass) throw new Error("Нет учётки: задайте ARCHMAP_USERNAME/ARCHMAP_PASSWORD или mcp/.env");
  return { user, pass };
}

async function login() {
  const { user, pass } = credentials();
  const r = await fetch(`${BACKEND}/api/v1/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ username: user, password: pass }),
  });
  if (!r.ok) throw new Error(`Вход не удался: ${r.status}`);
  return (await r.json()).access_token;
}

async function api(token, path, projectId = null) {
  const headers = { Authorization: `Bearer ${token}`, ...(projectId ? { "X-Project-Id": projectId } : {}) };
  const r = await fetch(`${BACKEND}/api/v1${path}`, { headers });
  if (!r.ok) throw new Error(`GET ${path} -> ${r.status}`);
  return r.json();
}

// Спецификация OpenAPI холсту не нужна, а в снимке весила бы больше всей сцены.
const slim = (node) => ({ ...node, openapi_spec: null });

const token = await login();
const project = (await api(token, "/projects")).find((p) => p.name === PROJECT_NAME);
if (!project) throw new Error(`Нет проекта «${PROJECT_NAME}»`);
const pid = project.id;
const all = await api(token, "/nodes/all", pid);
const byId = new Map(all.map((n) => [n.id, n]));

let focus = null;
if (FOCUS_NAME) {
  const hits = all.filter((n) => n.name === FOCUS_NAME);
  if (hits.length !== 1) throw new Error(`Объект «${FOCUS_NAME}»: найдено ${hits.length}, нужен ровно один`);
  focus = hits[0];
}

// Предки уровня (корень → непосредственный родитель): подписи вложенных рамок.
const ancestors = [];
for (let id = focus?.parent_id; id; id = byId.get(id)?.parent_id) {
  const n = byId.get(id);
  ancestors.unshift({ id: n.id, name: n.name, is_external: n.is_external });
}

const graph = await api(token, focus ? `/nodes/${focus.id}/context-graph` : "/nodes/graph", pid);
graph.nodes = graph.nodes.map(slim);
// Раскрытия из вида не берём: живая схема стартует свёрнутой, раскрывает посетитель.
const localIds = new Set(graph.nodes.map((n) => n.id));
graph.layout = Object.fromEntries(
  Object.entries(graph.layout)
    .filter(([id]) => POSITIONS === "all" || (POSITIONS === "locals" && localIds.has(id)))
    .map(([id, p]) => [id, { x: p.x, y: p.y }]),
);

// Составы контейнеров — ответы GET /nodes?parent_id= для каждого узла с детьми.
const children = {};
for (const n of all) {
  if (n.has_children) children[n.id] = (await api(token, `/nodes?parent_id=${n.id}`, pid)).map(slim);
}

const scene = {
  source: { project: PROJECT_NAME, focus: FOCUS_NAME },
  graph,
  containerId: focus ? (focus.parent_id ?? null) : null,
  ...(focus ? { layoutViewId: focus.id } : {}),
  ancestors,
  children,
};
const where = `${FOCUS_NAME ? `страница «${FOCUS_NAME}»` : "корневой уровень"}, позиции ${POSITIONS}`;
writeFileSync(OUT, [
  "// ГЕНЕРАТ scripts/landing-embed-scene.mjs — руками не править, перегенерировать скриптом.",
  `// Снимок: «${PROJECT_NAME}», ${where}.`,
  'import type { LandingScene } from "./scene";',
  "",
  `export const SCENE: LandingScene = ${JSON.stringify(scene, null, 2)};`,
  "",
].join("\n"));
const kids = Object.values(children).reduce((s, l) => s + l.length, 0);
console.log(`${where}: узлов ${graph.nodes.length}, связей ${graph.edges.length}, концов ${graph.endpoints.length}, `
  + `позиций ${Object.keys(graph.layout).length}; составы ${Object.keys(children).length} контейнеров (${kids} детей) → ${OUT}`);
