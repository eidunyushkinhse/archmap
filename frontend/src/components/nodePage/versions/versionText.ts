// Тексты панели версий документации (docs/tasks/doc-versions.md §7): строка статуса
// элемента, путь объекта перед именем, заголовок экрана элемента, перечень
// незафиксированных изменений, «дата · автор», пояснение окна отката и строка его
// замечаний. Чистые функции над контрактом — словарь подписей и слов статуса один, в
// nodeTerms.
import { VERSION_CATEGORY } from "../../nodeTerms";
import { plural } from "../../../ui/plural";
import type { RestorePreview, VersionItem, VersionOut } from "../../../types";

// Сколько изменений перечислять в строке «Есть изменения с vN: …» — дальше «и ещё M».
const PENDING_SHOWN = 3;
// Сколько замечаний отката показывать строкой над списком — дальше «и ещё M».
const REMARKS_SHOWN = 2;

// Категории, у которых элемент — сам объект (его имя и есть name, путь кончается им)
// или его единственная часть без своего имени (спека «OpenAPI», конфигурация «N
// параметров», размещение «N площадок»): их называет путь объекта, а не name.
const OBJECT_LEVEL = new Set<VersionItem["category"]>([
  "props",
  "approval",
  "spec",
  "config",
  "placement",
]);

/** «изменена · +3 −2»: слово статуса в роде категории и, если есть, подробность. У
 *  конфигурации подробность бывает равна слову («изменена») — тогда без повтора. */
export function statusText(item: VersionItem): string {
  const word = VERSION_CATEGORY[item.category].status[item.status];
  return item.summary && item.summary !== word ? `${word} · ${item.summary}` : word;
}

/** Путь объекта, который тихо стоит перед именем элемента. У свойств и статуса
 *  страницы путь кончается самим объектом — его имя уже в name, повтор срезаем. У
 *  корня среза путь пуст. */
export function pathPrefix(item: VersionItem): string {
  const path = item.node_path;
  if (item.category !== "props" && item.category !== "approval") return path;
  if (path === item.name) return "";
  const tail = ` / ${item.name}`;
  return path.endsWith(tail) ? path.slice(0, -tail.length) : path;
}

/** Заголовок экрана элемента «категория · имя». У спеки имя совпадает с категорией
 *  («OpenAPI») — вместо него путь объекта, а у корня среза одна категория. */
export function itemTitle(item: VersionItem): string {
  const label = VERSION_CATEGORY[item.category].label;
  if (item.name !== label) return `${label} · ${item.name}`;
  return item.node_path ? `${label} · ${item.node_path}` : label;
}

/** Элемент внутри фразы: «схема логики «Создать заказ»», «конфигурация «Заказы /
 *  Сервис заказов»», у корня среза — просто «конфигурация». */
function inlineName(item: VersionItem): string {
  const inline = VERSION_CATEGORY[item.category].inline;
  const subject = OBJECT_LEVEL.has(item.category) ? item.node_path : item.name;
  return subject ? `${inline} «${subject}»` : inline;
}

/** «изменения с v3: схема логики «Создать заказ», конфигурация и ещё 2» — строка над
 *  списком версий (с «Есть …») и подзаголовок окна фиксации. */
export function changesPhrase(latest: number, items: VersionItem[]): string {
  const head = `изменения с v${latest}`;
  if (items.length === 0) return head;
  const shown = items.slice(0, PENDING_SHOWN).map(inlineName).join(", ");
  const rest = items.length - PENDING_SHOWN;
  return `${head}: ${shown}${rest > 0 ? ` и ещё ${rest}` : ""}`;
}

/** Дата версии — как на карточке проекта («19 окт.»); у прошлых лет — с годом, иначе
 *  история за несколько лет читалась бы двусмысленно. */
function versionDate(iso: string): string {
  const d = new Date(iso);
  const sameYear = d.getFullYear() === new Date().getFullYear();
  return d.toLocaleDateString("ru-RU", sameYear
    ? { day: "numeric", month: "short" }
    : { day: "numeric", month: "short", year: "numeric" });
}

/** «19 окт. · petrova»; автора удалили — прочерк (история остаётся без автора). */
export function versionMeta(v: VersionOut): string {
  return `${versionDate(v.created_at)} · ${v.author ?? "—"}`;
}

/** Пояснение окна «Восстановить версию N?» (прототип, openRestore): к чему вернётся
 *  документация, сохранится ли незафиксированное, сколько объектов удалится и — если
 *  процессы есть — что они не откатываются. */
export function restoreLead(title: string, v: VersionOut, preview: RestorePreview): string {
  const parts = [`Документация «${title}» вернётся к состоянию v${v.number} (${v.comment}).`];
  if (preview.pending) parts.push("Текущие незафиксированные изменения сохранятся версией «Перед откатом».");
  if (preview.deleted_nodes > 0) {
    const n = preview.deleted_nodes;
    parts.push(`Будут удалены объекты, появившиеся после v${v.number}: ${n} ${plural(n, ["объект", "объекта", "объектов"])}.`);
  }
  if (preview.has_processes) parts.push("Процессы не откатываются, они общие с другими объектами.");
  return parts.join(" ");
}

/** Замечания отката одной фразой: первые два, дальше «и ещё M». Замечание сервера —
 *  законченная фраза со своим «не восстановлена: …», поэтому общего зачина нет: иначе
 *  вышло бы «Не восстановлено: связь … не восстановлена». */
export function remarksLine(remarks: string[]): string {
  if (remarks.length === 0) return "";
  const shown = remarks.slice(0, REMARKS_SHOWN).join("; ");
  const rest = remarks.length - REMARKS_SHOWN;
  const text = `${shown}${rest > 0 ? ` и ещё ${rest}` : ""}.`;
  return text.charAt(0).toUpperCase() + text.slice(1);
}
