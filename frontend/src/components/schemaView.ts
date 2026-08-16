// Конфигурация фильтра «Вид схемы» — клиентский визуальный слой поверх данных
// (НЕ раскладка узла, НЕ серверное состояние). Логика вынесена из SchemaViewFilter.tsx
// отдельным модулем: компонентный файл не должен экспортировать ещё и константы/функции
// (правило react-refresh). Семантика: цвет = статус узла всегда; вид = какие статусы
// показывать (остальные приглушаются на холсте, но не удаляются).
import { getCurrentProjectId } from "../api/projectScope";
import type { NodeStatus } from "../types";

export type SchemaView = "asis" | "all" | "tobe";

// Какие статусы видит каждый вид + подпись и подсказка. Порядок массива = порядок
// сегментов в переключателе.
export const SCHEMA_VIEWS: {
  id: SchemaView; label: string; hint: string; show: Set<NodeStatus>;
}[] = [
  {
    id: "asis", label: "Как есть",
    hint: "Что физически работает сейчас, включая узлы под вывод; проектируемое скрыто.",
    show: new Set<NodeStatus>(["existing", "deprecated"]),
  },
  {
    id: "all", label: "Переход",
    hint: "Полная картина миграции: и существующее, и проектируемое, и выводимое.",
    show: new Set<NodeStatus>(["existing", "planned", "deprecated"]),
  },
  {
    id: "tobe", label: "Как будет",
    hint: "Целевая система; выводимое из эксплуатации скрыто.",
    show: new Set<NodeStatus>(["existing", "planned"]),
  },
];

export const VIEW_BY_ID: Record<SchemaView, (typeof SCHEMA_VIEWS)[number]> =
  Object.fromEntries(SCHEMA_VIEWS.map((v) => [v.id, v])) as Record<SchemaView, (typeof SCHEMA_VIEWS)[number]>;

// Видимы ли узлы статуса st при текущем виде.
export function viewShows(view: SchemaView, st: NodeStatus): boolean {
  return VIEW_BY_ID[view].show.has(st);
}

// Показывать ли управление статусами («Вид схемы», «Принять переход»).
//
// Истина — ПРОЕКТНАЯ: обе вещи относятся ко всему проекту, поэтому основа ответа —
// признак с сервера (GraphResponse.has_status_info). Состав текущего уровня
// добавлен вторым слагаемым не для полноты, а ради мгновенной реакции: правка
// статуса узла в редакторе меняет только локальный стейт, уровень при этом НЕ
// перезагружается, и серверный признак остаётся протухшим до следующей загрузки.
export function showStatusControls(
  projectHasStatuses: boolean,
  ...levelItems: { status: NodeStatus }[][]
): boolean {
  return projectHasStatuses || levelItems.some((arr) => arr.some((i) => i.status !== "existing"));
}

// Ключ localStorage для выбранного вида — СВОЙ у каждого проекта. Прежде ключ был
// один на всё приложение, и вид, выставленный в одном проекте, гасил узлы и шаги в
// другом (П4 челленджа 2026-08-16). Вид описывает КОНКРЕТНУЮ схему («что здесь
// работает сейчас»), а не привычку читателя вообще: в проекте без планируемых узлов
// он вообще ни на что не влияет, и переносить его туда не за чем.
//
// Прежний глобальный ключ — это тот же префикс без суффикса проекта. Он оставлен
// РАЗОВЫМ семенем: проект, в котором человек работает сейчас, унаследует уже
// выставленный вид (иначе картинка сменилась бы у него под руками), а на первой же
// записи ключ удаляется — дальше вид у каждого проекта свой.
const VIEW_KEY = "archmap-schema-view";

function viewKey(projectId: string | null): string {
  return projectId ? `${VIEW_KEY}:${projectId}` : VIEW_KEY;
}

function parseView(raw: string | null): SchemaView | null {
  return raw === "asis" || raw === "tobe" || raw === "all" ? raw : null;
}

// Прочитать сохранённый вид текущего проекта (дефолт «переход»/all).
export function readSchemaView(): SchemaView {
  const pid = getCurrentProjectId();
  return parseView(localStorage.getItem(viewKey(pid)))
    ?? parseView(localStorage.getItem(VIEW_KEY))
    ?? "all";
}

// Запомнить вид текущего проекта. Заодно гасит старый глобальный ключ: отслужив
// семенем, он иначе вечно подсовывал бы чужой вид каждому новому проекту.
export function writeSchemaView(view: SchemaView): void {
  const pid = getCurrentProjectId();
  localStorage.setItem(viewKey(pid), view);
  if (pid) localStorage.removeItem(VIEW_KEY);
}
