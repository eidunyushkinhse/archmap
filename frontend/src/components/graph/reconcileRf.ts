// Реконсиляция сборки RF (Ф2 эпика плавности): assembleRfGraph строит ВСЕ объекты
// заново, из-за чего каждый apply обесценивал React.memo узлов/рёбер — тотальный
// ре-рендер сцены на любой прогон. Здесь свежесобранные объекты сравниваются с
// текущими из стейта RF, и при СОДЕРЖАТЕЛЬНОМ равенстве наружу уходит ПРОШЛЫЙ
// объект (та же ссылка → memo-бейлаут). Побочный бонус: выделение (selected) и
// замеры (measured) неизменённых узлов переживают пересчёт раскладки.
//
// Правила сравнения:
//  - ключи — ОБЪЕДИНЕНИЕ prev и next (исчезновение поля — тоже изменение: иначе
//    залипали бы style приглушения, parentId рамки, hidden маски);
//  - RF-приватные поля (selected/dragging/measured) не сравниваются: их пишет сам
//    RF в контролируемый стейт, сборка их не задаёт, а сохранение прошлого объекта
//    сохраняет и их — желаемое поведение;
//  - функции равны функциям: обработчики в data зовут getCb() лениво (см.
//    assembleRf), поэтому идентичность замыкания не несёт смысла. Функция против
//    не-функции — различие.
// Класс риска «залипший рендер» покрыт юнитами (чувствительность к каждому полю
// сборки) и headless-гейтом «финал == перезагрузка».
import type { Node as RFNode, Edge as RFEdge } from "@xyflow/react";

// Поля, которыми владеет сам React Flow (пишутся через onNodesChange/onEdgesChange
// в контролируемый стейт): для сравнения «изменила ли СБОРКА объект» они шум.
const RF_PRIVATE = new Set(["selected", "dragging", "measured"]);

// Структурное равенство JSON-подобных значений; функции считаются равными между
// собой (ленивые обёртки над latest-ref — их идентичность не смысл).
export function contentEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a === "function" && typeof b === "function") return true;
  if (a == null || b == null) return a === b;
  if (typeof a !== "object" || typeof b !== "object") return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) if (!contentEqual(a[i], b[i])) return false;
    return true;
  }
  const ra = a as Record<string, unknown>;
  const rb = b as Record<string, unknown>;
  for (const k of new Set([...Object.keys(ra), ...Object.keys(rb)])) {
    if (!contentEqual(ra[k], rb[k])) return false;
  }
  return true;
}

const sameItem = (prev: RFNode | RFEdge, next: RFNode | RFEdge): boolean => {
  const rp = prev as unknown as Record<string, unknown>;
  const rn = next as unknown as Record<string, unknown>;
  for (const k of new Set([...Object.keys(rp), ...Object.keys(rn)])) {
    if (RF_PRIVATE.has(k)) continue;
    if (!contentEqual(rp[k], rn[k])) return false;
  }
  return true;
};

// Общий проход: на выходе массив в порядке next, где содержательно неизменённые
// элементы представлены ПРОШЛЫМИ объектами. Если не изменилось ничего (включая
// состав и порядок) — возвращается ПРОШЛЫЙ МАССИВ (React бейлаутит setState).
function reconcile<T extends RFNode | RFEdge>(prev: T[], next: T[]): T[] {
  const prevById = new Map(prev.map((x) => [x.id, x]));
  const out: T[] = [];
  let sameArray = prev.length === next.length;
  for (let i = 0; i < next.length; i++) {
    const n = next[i];
    const p = prevById.get(n.id);
    const keep = p && sameItem(p, n) ? p : n;
    out.push(keep);
    if (sameArray && keep !== prev[i]) sameArray = false;
  }
  return sameArray ? prev : out;
}

export const reconcileNodes = (prev: RFNode[], next: RFNode[]): RFNode[] => reconcile(prev, next);
export const reconcileEdges = (prev: RFEdge[], next: RFEdge[]): RFEdge[] => reconcile(prev, next);
