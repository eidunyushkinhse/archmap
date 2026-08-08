// Раскладка плана синхронизации по разделам превью (Фаза 3 docs/plan-arch-sync.md).
// Чистые функции: модалка только рисует то, что здесь посчитано.
//
// Показываем ТОЛЬКО изменения: действие unchanged — норма (в идеальном случае им
// занят весь план, см. критерий-фикспойнт), и вываливать его списком значит
// топить настоящий diff. Счётчик неизменных остаётся в сводке.
import type { SyncApplyOut, SyncEdgeAction, SyncNodeAction, SyncPreviewOut } from "../../types";

/** Человеческие имена полей узла (fields действия update). */
const FIELD_LABEL: Record<string, string> = {
  name: "имя",
  description: "описание",
  role: "роль",
  technology: "технология",
  shape: "форма",
  status: "статус",
  source_ref: "источник",
};

/** Как объект найден в схеме — от этого зависит доверие к строке плана.
 *  Формулировки без внутренних терминов: пользователю важно, по чему сошлось. */
const MATCHED_LABEL: Record<string, string> = {
  source: "нашли по репозиторию",
  name: "нашли по имени",
};

export interface PlanRow {
  path: string;
  /** Пояснение справа: какие поля меняются / чем опознан узел. */
  note: string;
}

export interface PlanSection {
  key: string;
  title: string;
  rows: PlanRow[];
  /** Раздел требует внимания (пропажи), а не просто сообщает о росте схемы. */
  attention?: boolean;
}

function nodeNote(a: SyncNodeAction): string {
  const parts: string[] = [];
  if (a.fields?.length) {
    parts.push(a.fields.map((f) => FIELD_LABEL[f] ?? f).join(", "));
  }
  // «по имени» стоит показать даже без изменений полей: матч по имени слабее
  // якорного, и пользователь вправе усомниться в нём глазами.
  if (a.matched_by && MATCHED_LABEL[a.matched_by]) parts.push(MATCHED_LABEL[a.matched_by]);
  return parts.join(" · ");
}

const edgeRow = (e: SyncEdgeAction): PlanRow => ({
  path: `${e.source_path} → ${e.target_path}`,
  note: "",
});

/** Разделы превью: только непустые, в порядке «рост схемы → внимание». */
export function planSections(p: SyncPreviewOut): PlanSection[] {
  const nodes = (action: string): SyncNodeAction[] => (p.nodes ?? []).filter((a) => a.action === action);
  const edges = (action: string): SyncEdgeAction[] => (p.edges ?? []).filter((e) => e.action === action);
  const all: PlanSection[] = [
    {
      key: "nodes_create",
      title: "Новые объекты",
      rows: nodes("create").map((a) => ({ path: a.path, note: "" })),
    },
    {
      key: "nodes_update",
      title: "Изменённые объекты",
      rows: nodes("update").map((a) => ({ path: a.path, note: nodeNote(a) })),
    },
    {
      key: "edges_create",
      title: "Новые связи",
      rows: edges("create").map(edgeRow),
    },
    {
      key: "nodes_missing",
      title: "Пропали из прогона",
      rows: nodes("missing").map((a) => ({ path: a.path, note: "" })),
      attention: true,
    },
    {
      key: "edges_missing",
      title: "Пропавшие связи",
      rows: edges("missing").map(edgeRow),
      attention: true,
    },
  ];
  return all.filter((s) => s.rows.length > 0);
}

/** Строка-сводка для шапки превью. Пустой план — отдельная формулировка. */
export function planSummary(p: SyncPreviewOut): string {
  if (!p.ok) return "";
  if (p.is_noop) return "Применять нечего. Схема уже соответствует YAML";
  const s = p.summary ?? {};
  const bits: string[] = [];
  const add = (n: number | undefined, text: string) => {
    if (n) bits.push(`${n} ${text}`);
  };
  add(s.nodes_create, "новых");
  add(s.nodes_update, "изменённых");
  add(s.nodes_missing, "пропавших");
  add(s.edges_create, "новых связей");
  add(s.edges_missing, "пропавших связей");
  const unchanged = (s.nodes_unchanged ?? 0) + (s.edges_unchanged ?? 0);
  const tail = unchanged ? ` · без изменений ${unchanged}` : "";
  return bits.length ? bits.join(", ") + tail : "Изменений нет" + tail;
}

/** Итог применения — текст тоста. skipped называем явно: эти действия потеряли
 *  цель между расчётом и записью, и промолчать о них значит соврать «применено всё». */
export function applySummary(r: SyncApplyOut): string {
  const bits: string[] = [];
  const add = (arr: string[] | undefined, text: string) => {
    if (arr?.length) bits.push(`${arr.length} ${text}`);
  };
  add(r.created_nodes, "создано");
  add(r.updated_nodes, "обновлено");
  add(r.deprecated_nodes, "помечено устаревшими");
  add(r.created_edges, "новых связей");
  const head = bits.length ? `Схема обновлена: ${bits.join(", ")}` : "Схема уже актуальна";
  return r.skipped?.length ? `${head}. Пропущено: ${r.skipped.length}` : head;
}
