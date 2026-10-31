// Слова окна «Собрать с компонентов» (Р19 эпика «Элемент архитектуры»,
// docs/plan-c4-elements.md; решения владельца 2026-10-31). Знание контейнера в
// приоритете — об этом окно говорит строками-фактами: вопроса там нет. Краевые случаи
// (одноимённый параметр только у компонентов, несколько спецификаций при пустом
// контейнере) — вопросы на языке разбора ввоза (project/remainder/questionText):
// заголовок-вопрос, «почему возник вопрос» и сноска «Если не отвечать, то …». Что
// собирается, решает сервер (app/facts_transfer.py): здесь только текст по его превью
// и отчёту.
import type { CollectFactsOut, CollectFactsPreview } from "../../types";
import { plural } from "../../ui/plural";
import { joinNames } from "./elementChange";

type Clash = CollectFactsPreview["param_clashes"][number];

export interface CollectQuestionTexts {
  title: string;
  why: string;
  ifLeft: string;
}

const PARAM: [string, string, string] = ["параметр", "параметра", "параметров"];
const SPEC: [string, string, string] = ["спецификация", "спецификации", "спецификаций"];
const DROPPED: [string, string, string] = ["будет отброшен", "будут отброшены", "будут отброшены"];
// Сколько имён параметров называть в итоге: дальше — счётчиком.
const NAMES_CAP = 5;

const count = (n: number, forms: [string, string, string]): string => `${n} ${plural(n, forms)}`;
const quoted = (names: string[]): string => joinNames(names.map((n) => `«${n}»`));

// «вторая будет отброшена» против «остальные будут отброшены»: пара — самый частый
// случай, и множественное число в нём звучит как «их много» (то же, что у вопросов ввоза).
const rest = (n: number): string => (n === 2 ? "вторая будет отброшена" : "остальные будут отброшены");

/**
 * Сколько параметров каждого компонента сбор отбросит: одноимённые с записью
 * контейнера (container_keeps). Компонент → число; нет ключа — ноль.
 */
export function droppedParams(p: CollectFactsPreview, containerId: string): Record<string, number> {
  const out: Record<string, number> = {};
  for (const c of p.param_clashes) {
    if (!c.container_keeps) continue;
    for (const k of c.candidates) {
      if (k.node_id !== containerId) out[k.node_id] = (out[k.node_id] ?? 0) + 1;
    }
  }
  return out;
}

/**
 * Строка компонента в окне сбора: «api · 2 параметра, спецификация». Отбрасываемые
 * параметры названы честно: «worker · 1 параметр, будет отброшен», «api · 2 параметра,
 * 1 будет отброшен, спецификация».
 */
export function collectLine(c: CollectFactsPreview["components"][number], dropped = 0): string {
  const parts: string[] = [];
  if (c.params > 0) {
    const gone = Math.min(dropped, c.params);
    const verb = plural(gone, DROPPED);
    const tail = gone === 0 ? "" : gone === c.params ? `, ${verb}` : `, ${gone} ${verb}`;
    parts.push(count(c.params, PARAM) + tail);
  }
  if (c.has_spec) parts.push("спецификация");
  return `${c.name} · ${parts.join(", ")}`;
}

/** Вопрос — одноимённый параметр, которого у контейнера нет. */
export const isParamQuestion = (c: Clash): boolean => !c.container_keeps;

/** Держатели спецификации среди компонентов (без самого контейнера). */
export const specHolders = (p: CollectFactsPreview, containerId: string): CollectFactsPreview["specs"] =>
  p.specs.filter((s) => s.node_id !== containerId);

/** Вопрос о спецификации: своей у контейнера нет, а держателей среди компонентов несколько. */
export const asksSpec = (p: CollectFactsPreview, containerId: string): boolean =>
  !p.container_has_spec && specHolders(p, containerId).length > 1;

/**
 * Строки-факты: что решено без вопроса по правилу приоритета контейнера. Параметр
 * контейнера остаётся, одноимённые у компонентов отбрасываются; своя спецификация
 * контейнера остаётся, спецификации компонентов отбрасываются; единственная
 * спецификация компонента при пустом контейнере переезжает.
 */
export function collectFacts(p: CollectFactsPreview, containerId: string): string[] {
  const out: string[] = [];
  for (const c of p.param_clashes) {
    if (!c.container_keeps) continue;
    const others = c.candidates.filter((x) => x.node_id !== containerId).map((x) => x.node_name);
    out.push(
      `Параметр «${c.name}» есть у контейнера — остаётся его описание, `
      + (others.length === 1 ? `у компонента «${others[0]}»` : `у компонентов ${quoted(others)}`)
      + " параметр будет отброшен",
    );
  }
  const holders = specHolders(p, containerId).map((s) => s.name);
  if (p.container_has_spec && holders.length > 0) {
    out.push(holders.length === 1
      ? `У контейнера есть своя спецификация — спецификация компонента «${holders[0]}» будет отброшена`
      : `У контейнера есть своя спецификация — спецификации компонентов ${quoted(holders)} будут отброшены`);
  }
  const single = p.specs.find((s) => s.node_id === p.single_spec_from);
  if (single !== undefined) out.push(`Спецификация компонента «${single.name}» переедет контейнеру`);
  return out;
}

export function paramQuestion(c: Clash, containerName: string): CollectQuestionTexts {
  const names = c.candidates.map((x) => x.node_name);
  // «по-разному» — только когда описания и правда расходятся: одинаковые описания при
  // разных записях (тип, дефолт) — тоже вопрос, но без ложного «по-разному».
  const differ = new Set(c.candidates.map((x) => (x.description ?? "").trim())).size > 1;
  return {
    title: `Параметр «${c.name}» описан у компонентов ${quoted(names)}${differ ? " по-разному" : ""}. `
      + "Чьё описание считаем верным?",
    why: `У контейнера «${containerName}» этого параметра нет, поэтому приоритета нет: ArchMap `
      + `оставит одну запись у контейнера, ${rest(names.length)}.`,
    ifLeft: "Если не отвечать, то параметр останется у компонентов, рекомендация тоже останется.",
  };
}

export function specQuestion(holders: string[], containerName: string): CollectQuestionTexts {
  return {
    title: `Спецификация есть у компонентов ${quoted(holders)}. `
      + `Чью считаем спецификацией контейнера «${containerName}»?`,
    why: "У контейнера своей спецификации нет, а у компонента её быть не может: спецификация"
      + ` описывает API контейнера целиком. ArchMap перенесёт выбранную, ${rest(holders.length)}.`,
    ifLeft: "Если не отвечать, то спецификации останутся у компонентов, рекомендация тоже останется.",
  };
}

/** Подпись варианта-кандидата: описание параметра в кавычках или «без описания». */
export const candidateSub = (description: string | null): string =>
  description?.trim() ? `«${description.trim()}»` : "без описания";

/**
 * Итог сбора: собранное, отброшенное и оставленное у компонентов — по строке на часть,
 * пустые части не называются. «Собрано: 3 параметра, спецификация.»
 */
export function collectResult(out: CollectFactsOut): string[] {
  const got: string[] = [];
  if (out.moved_params > 0) got.push(count(out.moved_params, PARAM));
  if (out.spec_moved) got.push("спецификация");
  const lines = [got.length > 0 ? `Собрано: ${got.join(", ")}.` : "Ничего не собрано."];

  const dropped: string[] = [];
  if (out.dropped_params > 0) dropped.push(count(out.dropped_params, PARAM));
  if (out.dropped_specs > 0) dropped.push(count(out.dropped_specs, SPEC));
  if (dropped.length > 0) lines.push(`Отброшено: ${dropped.join(", ")}.`);

  const left: string[] = [];
  const names = out.left_params;
  if (names.length > 0) {
    const shown = names.length > NAMES_CAP
      ? `${names.slice(0, NAMES_CAP).map((n) => `«${n}»`).join(", ")} и ещё ${names.length - NAMES_CAP}`
      : quoted(names);
    left.push(`${names.length === 1 ? "параметр" : "параметры"} ${shown}`);
  }
  if (out.left_specs > 0) left.push(count(out.left_specs, SPEC));
  if (left.length > 0) lines.push(`Осталось у компонентов: ${left.join(", ")}.`);
  return lines;
}
