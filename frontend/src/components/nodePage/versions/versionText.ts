// Тексты панели версий документации (docs/tasks/doc-versions.md §7): строка статуса
// элемента, путь объекта перед именем, заголовок экрана элемента, перечень
// незафиксированных изменений и «дата · автор». Чистые функции над контрактом —
// словарь подписей и слов статуса один, в nodeTerms.
import { VERSION_CATEGORY } from "../../nodeTerms";
import type { VersionItem, VersionOut } from "../../../types";

// Сколько изменений перечислять в строке «Есть изменения с vN: …» — дальше «и ещё M».
const PENDING_SHOWN = 3;

// Категории, у которых элемент — сам объект (его имя и есть name, путь кончается им)
// или его единственная часть без своего имени (спека «OpenAPI», конфигурация «N
// параметров»): их называет путь объекта, а не name.
const OBJECT_LEVEL = new Set<VersionItem["category"]>(["props", "approval", "spec", "config"]);

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
