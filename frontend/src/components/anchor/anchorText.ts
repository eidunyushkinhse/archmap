// Тексты поля «Источник» (до 2026-10-17 — «Якорь»; в коде понятие по-прежнему anchor/source_ref) —
// ОДНО место для строки «Источник» (страница объекта и панель редактора-карты) и превью ввоза.
//
// Пояснение «Что такое источник» (ⓘ, редакция v2 docs/plan-anchor-ux.md) жило в
// инспекторе редактора и ушло вместе с ним в редизайне (фаза 4а): строка «Источник» теперь
// одна на страницу и панель, без справки.

import type { NodeSource } from "../../types";

// Абзац справки «?» с жирным подзаголовком (тексты справок, например element/elementText).
export interface HelpParagraph {
  // Жирный подзаголовок абзаца (он же — то, что человек читает по диагонали).
  head: string;
  body: string;
}

// Вид источника: код (репозиторий + путь) либо имя зависимости. Третьего нет —
// контур развёртывания (образ, объект k8s) из идентичности убран (Ф0).
export type AnchorKind = "code" | "dependency";

export const anchorKind = (src: NodeSource | null | undefined): AnchorKind | null =>
  !src ? null : src.repo ? "code" : src.host ? "dependency" : null;

/** Источник в человеческий вид: «github.com/org/repo, путь src/api» / «payments». */
export function anchorReadable(src: NodeSource): string {
  if (src.repo) return src.path ? `${src.repo}, путь ${src.path}` : src.repo;
  return src.host ?? "";
}

/** Источник одной строкой для строки свойств страницы: «github.com/org/repo / src/api»,
 *  у зависимости — её имя. Без приставок «код:» и «путь»: вид читается по самому значению. */
export function anchorCompact(src: NodeSource): string {
  if (src.repo) return src.path ? `${src.repo} / ${src.path}` : src.repo;
  return src.host ?? "";
}

// Подписи двух видов источника — в чтении и в переключателе формы.
export const KIND_LABEL = { code: "код", dependency: "имя зависимости" } as const;
export const KIND_TAB = { code: "Код", dependency: "Имя зависимости" } as const;

// Узел без источника: не «пусто», а объяснение последствия — по чему его тогда узнают.
// В интерфейсе строки нет (там короткое NO_ANCHOR_SHORT); слово держит карточка объекта
// у агента (MCP), и сторож mcp/tests/test_node_card.py сверяет её с этим словарём.
/** @public */
export const NO_ANCHOR = "нет, объект опознаётся по имени";
// Пустое значение строки «Источник» (страница объекта и панель редактора).
export const NO_ANCHOR_SHORT = "не задан";

export const FIELD_LABEL = {
  repo: "Репозиторий",
  path: "Путь в репозитории (необязательно)",
  host: "Имя",
};

export const PLACEHOLDER = {
  repo: "github.com/org/repo или адрес клона",
  path: "src/api",
  host: "postgres, kafka, payments",
};

// Что скажет форма, когда оба поля пусты: сохранение здесь — это очистка источника.
export const PREVIEW_EMPTY = "Если источника не будет, то объект будет опознаваться по имени";
export const PREVIEW_PREFIX = "будет сохранено как:";

// ── Основание склейки словами (Ф2 docs/plan-anchor-ux.md) ────────────────────
//
// ОДИН словарь на три превью — импорта, догрузки и синка: пользователь читает
// одну и ту же фразу, чем бы он ни ввозил. Значения приходят с бэка (мердж и
// sync_plan считают их одним и тем же правилом), здесь только слова.

/** Чем два объекта признаны одним: совпал источник-код, источник-имя зависимости, имя. */
export type MergeBasis = "code" | "dependency" | "name";

const BASIS_LABEL: Record<MergeBasis, string> = {
  code: "по коду",
  dependency: "по имени зависимости",
  name: "по имени",
};

/** Основание словами. Для «по имени» дописываем ГДЕ: имя решает только внутри
 *  своего контейнера, и без него фраза обещает больше, чем сделал матчер. */
export function basisLabel(basis: MergeBasis, path?: string): string {
  if (basis !== "name") return BASIS_LABEL[basis];
  const parts = (path ?? "").split(" / ");
  const parent = parts.slice(0, -1).join(" / ");
  return parent ? `по имени внутри «${parent}»` : "по имени на верхнем уровне";
}

/** Источник нового объекта строкой: с ним — какой именно, без него — последствие. */
export function anchorNote(source: NodeSource | null | undefined): string {
  const kind = anchorKind(source);
  return source && kind
    ? `источник: ${KIND_LABEL[kind]} ${anchorReadable(source)}`
    : "источника нет, объект будет опознаваться по имени";
}
