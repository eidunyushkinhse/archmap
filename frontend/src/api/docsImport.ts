import { api } from "./client";
import type {
  ChannelsImportReport,
  DataImportReport,
  DocsImportReport,
  NodeDocKind,
} from "../types";

// Дозаливка доков от ИИ-агента: промпт со срезом схемы, dry-run превью пакета
// archmap-docs и применение. Пакет — самодостаточные файлы: схема логики .mmd с
// метаданными в шапке, файл спеки OpenAPI. Файла-описи нет (docs/plan-docs-mmd.md),
// поэтому запрос несёт node_id: объект, для которого открыто окно.
export interface DocsFile {
  name: string;
  content: string;
}

export interface DocsPromptParams {
  nodeId?: string | null; // поддерево; null/undefined — весь проект
  include: "logic" | "api" | "both";
  lang: "ru" | "en";
  hints?: string;
  // Гранулярный режим «по одной схеме»: воркер/эндпоинт, на котором фокусируется
  // агент (бэк добавляет в промпт приоритетный блок «опиши ТОЛЬКО <target>»)
  target?: string;
}

// Фильтр плана превью/применения: «logic» — только схемы логики (node_docs),
// «api» — только OpenAPI-спеки. Раздельные окна дозаливки (DocsAgentModal /
// SpecAgentModal) не смешивают сущности. Без only бэк строит полный план.
export type DocsOnly = "logic" | "api";

/** Правка строки превью: пользователь исправил имя или вид схемы перед записью.
 *  Раньше вид правился ПЕРЕЗАПИСЬЮ текста манифеста — манифеста больше нет. */
export interface DocsOverride {
  file: string;
  name?: string;
  kind?: NodeDocKind;
  node?: string;
}

export interface DocsImportParams {
  files: DocsFile[];
  overwrite: boolean;
  only?: DocsOnly;
  /** Объект, для которого открыто окно: к нему уезжают схемы без адреса в шапке. */
  nodeId?: string | null;
  overrides?: DocsOverride[];
}

function body(p: DocsImportParams): Record<string, unknown> {
  const out: Record<string, unknown> = { files: p.files, overwrite: p.overwrite };
  if (p.only !== undefined) out.only = p.only;
  if (p.nodeId) out.node_id = p.nodeId;
  if (p.overrides?.length) out.overrides = p.overrides;
  return out;
}

export const docsImportApi = {
  prompt: (p: DocsPromptParams): Promise<{ prompt: string }> => {
    const q = new URLSearchParams();
    if (p.nodeId) q.set("node_id", p.nodeId);
    q.set("include", p.include);
    q.set("lang", p.lang);
    if (p.hints?.trim()) q.set("hints", p.hints.trim());
    if (p.target?.trim()) q.set("target", p.target.trim());
    return api.get<{ prompt: string }>(`/docs-import/prompt?${q.toString()}`);
  },
  preview: (p: DocsImportParams): Promise<DocsImportReport> =>
    api.post<DocsImportReport>("/docs-import/preview", body(p)),
  apply: (p: DocsImportParams): Promise<DocsImportReport> =>
    api.post<DocsImportReport>("/docs-import/apply", body(p)),
};

// Дозаливка ДАННЫХ (структура БД + обращения). Свой контракт, а не фильтр
// docs-import: там сущности «схема логики» и «спека», здесь — таблицы, колонки и
// обращения. Промпт без параметров: он один и не зависит от объекта окна.
export interface DataImportParams {
  files: DocsFile[];
  overwrite: boolean;
  /** Объект, для которого открыто окно: к нему уезжают записи без адреса в файле. */
  nodeId?: string | null;
}

function dataBody(p: DataImportParams): Record<string, unknown> {
  const out: Record<string, unknown> = { files: p.files, overwrite: p.overwrite };
  if (p.nodeId) out.node_id = p.nodeId;
  return out;
}

export const dataImportApi = {
  prompt: (): Promise<{ prompt: string }> => api.get<{ prompt: string }>("/data-import/prompt"),
  preview: (p: DataImportParams): Promise<DataImportReport> =>
    api.post<DataImportReport>("/data-import/preview", dataBody(p)),
  apply: (p: DataImportParams): Promise<DataImportReport> =>
    api.post<DataImportReport>("/data-import/apply", dataBody(p)),
};

// Дозаливка КАНАЛОВ брокера. Свой контракт и свой префикс, а не режим data-import:
// формат пакета другой (каналы с метой доставки и полями сообщений) и политика
// слияния другая — у брокера нет репозитория-владельца, один топик описывают пакеты
// разных репозиториев. Параметры те же: пакет, политика занятых полей, объект окна.
export const channelsImportApi = {
  prompt: (): Promise<{ prompt: string }> =>
    api.get<{ prompt: string }>("/channels-import/prompt"),
  preview: (p: DataImportParams): Promise<ChannelsImportReport> =>
    api.post<ChannelsImportReport>("/channels-import/preview", dataBody(p)),
  apply: (p: DataImportParams): Promise<ChannelsImportReport> =>
    api.post<ChannelsImportReport>("/channels-import/apply", dataBody(p)),
};
