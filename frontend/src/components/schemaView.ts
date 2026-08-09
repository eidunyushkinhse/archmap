// Конфигурация фильтра «Вид схемы» — клиентский визуальный слой поверх данных
// (НЕ раскладка узла, НЕ серверное состояние). Логика вынесена из SchemaViewFilter.tsx
// отдельным модулем: компонентный файл не должен экспортировать ещё и константы/функции
// (правило react-refresh). Семантика: цвет = статус узла всегда; вид = какие статусы
// показывать (остальные приглушаются на холсте, но не удаляются).
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

// Ключ localStorage для выбранного вида. Глобальный, не по проектам: вид — привычка
// пользователя, не свойство конкретной схемы.
export const SCHEMA_VIEW_KEY = "archmap-schema-view";

// Прочитать сохранённый вид (дефолт «переход»/all).
export function readSchemaView(): SchemaView {
  const saved = localStorage.getItem(SCHEMA_VIEW_KEY);
  return saved === "asis" || saved === "tobe" || saved === "all" ? saved : "all";
}
