// Слова разбора остатка: заголовки вопросов, «почему возник вопрос» и сноски
// «Если не отвечать» (§4 ТЗ «Остаток слияния — разбор вопросами» + раздел «Тексты
// архитектора» задания Ф2). Отдельный модуль от questions.ts: там сборка списка и
// подсчёты, здесь — только текст, формы по родам и склонения. Тексты ФИНАЛЬНЫЕ:
// правятся вместе с ТЗ, а не по вкусу.
import type {
  ContainerEdgeOut, FamilyConflictOut, FieldDisputeOut, FuzzyPairOut,
  IsolatedGroupOut, NodeShape, NodeStatus,
} from "../../../types";
import { plural } from "../../../ui/plural";
import { STATUS_META } from "../../graph/colors";

/** Последний сегмент пути: «Grafana / Сервер Grafana» → «Сервер Grafana». */
export const lastSegment = (path: string): string => path.split(" / ").pop() ?? path;

const cap = (s: string): string => s.charAt(0).toUpperCase() + s.slice(1);

/**
 * Число источников словами: «в двух источниках» / «в трёх источниках» / «в 5
 * источниках». Двойка и тройка прописью — так написаны тексты ТЗ (§4.2), и
 * цифра «2» посреди фразы выглядела бы счётчиком, а не количеством спорщиков.
 */
export function sourcesPhrase(n: number): string {
  if (n === 2) return "в двух источниках";
  if (n === 3) return "в трёх источниках";
  return `в ${n} источниках`;
}

// Человеческие имена форм C4 — та же карта, что в палитре NodeTreePanel и в
// SHAPE_LABEL страницы объекта (общего экспорта в проекте нет, поэтому копия).
const SHAPE_LABEL: Record<NodeShape, string> = {
  service: "Сервис",
  database: "База данных",
  broker: "Брокер",
  person: "Пользователь",
};

/**
 * Значение поля человеческими словами (Р5 задания): форма и статус приезжают
 * кодами контракта («service», «planned») — в вопросе они читались бы как
 * внутренности. Прочие поля показываются как есть.
 */
export function humanValue(field: string, value: string): string {
  if (field === "shape" && value in SHAPE_LABEL) return SHAPE_LABEL[value as NodeShape];
  if (field === "status" && value in STATUS_META) return STATUS_META[value as NodeStatus].label;
  return value;
}

// Формы по родам для спора содержимого (§4.1). diff — первая половина «почему».
interface FamilyForms {
  subj: string; plural: string; all: string; one: string; adj: string; diff: string;
}
const FAMILY: Record<FamilyConflictOut["family"], FamilyForms> = {
  doc: { subj: "объекта", plural: "схемы с одинаковым названием", all: "схемы",
    one: "какую", adj: "правильной", diff: "Схемы разные" },
  spec: { subj: "объекта", plural: "спеки с одинаковым названием", all: "спеки",
    one: "какую", adj: "правильной", diff: "Содержимое разное" },
  table: { subj: "объекта", plural: "таблицы с одинаковым названием", all: "таблицы",
    one: "какую", adj: "правильной", diff: "Содержимое разное" },
  channel: { subj: "канала", plural: "описания", all: "описания",
    one: "какое", adj: "правильным", diff: "Содержимое разное" },
  config: { subj: "параметра", plural: "значения", all: "значения",
    one: "какое", adj: "правильным", diff: "Содержимое разное" },
};

// Номер строки в начале текста ошибки: «Строка 84: у объекта два родителя».
// Регистр любой, разделитель — двоеточие, запятая, тире или ничего.
const ERROR_LINE_RE = /^\s*строка\s+(\d+)\s*[:.,–—-]?\s*/i;
// …и вторая, более частая форма: номер строки в СКОБКАХ посреди текста —
// «Некорректный YAML: ошибка разметки (строка 29). Частая причина …» именно так
// его кладёт бэк (app/import_yaml.py::_yaml_error). Без этой ветки статус
// говорил бы «Проблема в файле 2 · a.yaml: …», пряча самое полезное.
const ERROR_LINE_PAREN_RE = /\s*\(строка\s+(\d+)\)/i;

/**
 * Разбор первой ошибки для строки статуса (§2, Р7): номер строки выносится в
 * шаблон «Проблема в файле <чип>. Строка N: <текст>.», иначе остаётся один
 * текст. Хвостовая точка снимается — её ставит сам шаблон.
 */
export function splitErrorLine(text: string): { line: number | null; text: string } {
  const m = ERROR_LINE_RE.exec(text);
  if (m !== null) {
    return { line: Number(m[1]), text: text.slice(m[0].length).trim().replace(/\.$/, "") };
  }
  const p = ERROR_LINE_PAREN_RE.exec(text);
  if (p !== null) {
    // Скобки уходят из текста вместе с предшествующим пробелом: иначе на их
    // месте остаётся «разметки . Частая причина».
    const rest = text.replace(ERROR_LINE_PAREN_RE, "").trim().replace(/\.$/, "");
    return { line: Number(p[1]), text: rest };
  }
  return { line: null, text: text.trim().replace(/\.$/, "") };
}

/**
 * Тег вьюера по семье (§5.5): схема логики рисуется диаграммой, у прочих тел тег
 * называет их род — чтобы окно не обещало картинку там, где будет текст.
 */
export const VIEWER_TAG: Record<FamilyConflictOut["family"], string> = {
  doc: "mermaid · flowchart", spec: "openapi", table: "таблица",
  channel: "канал", config: "параметр",
};

/** Индекс кандидата-дефолта спора содержимого; −1 — дефолт «взять все». */
export const familyDefaultIndex = (c: FamilyConflictOut): number =>
  c.default.startsWith("cand:") ? Number(c.default.slice(5)) : -1;

// «второй будет отброшен» против «остальные будут отброшены»: пара спорщиков —
// самый частый случай, и множественное число в нём звучит как «их много».
const rest = (n: number, one: string, many: string): string => (n === 2 ? one : many);

export function familyTexts(c: FamilyConflictOut): { title: string; why: string; ifLeft: string } {
  const f = FAMILY[c.family];
  const i = familyDefaultIndex(c);
  const winner = c.candidates[i];
  return {
    title: `У ${f.subj} «${c.key}» в разных источниках разные ${f.plural}. `
      + `${cap(f.one)} считаем ${f.adj}?`,
    why: `${f.diff} (не совпадают побайтово), а названия одинаковые. `
      + `Непонятно, ${f.one} считать ${f.adj}.`,
    ifLeft: winner === undefined
      ? `Если не отвечать: будут добавлены все ${f.all}, при добавлении им будут назначены номера.`
      : `Если не отвечать: в проект попадёт вариант «${winner.source_label}», `
        + `${rest(c.candidates.length, "второй будет отброшен", "остальные будут отброшены")}.`,
  };
}

// Формы по полям (§4.2 + «Тексты архитектора»). Поле вне карты — запасная форма
// ТЗ: «{поле в нижнем регистре} заполнено».
interface FieldForms { what: string; q: string; adj: string }
const FIELD: Record<string, FieldForms> = {
  description: { what: "описание заполнено", q: "Какое", adj: "правильным" },
  technology: { what: "технология указана", q: "Какую", adj: "правильной" },
  role: { what: "роль указана", q: "Какую", adj: "правильной" },
  shape: { what: "форма указана", q: "Какую", adj: "правильной" },
  status: { what: "статус указан", q: "Какой", adj: "правильным" },
};

export function fieldTexts(d: FieldDisputeOut): { title: string; why: string; ifLeft: string } {
  const f = FIELD[d.field] ?? { what: `${d.field.toLowerCase()} заполнено`, q: "Какое", adj: "правильным" };
  const winner = d.candidates[d.default];
  const value = winner ? humanValue(d.field, winner.value) : "";
  return {
    title: `У объекта «${lastSegment(d.node_path)}» ${f.what} по-разному `
      + `${sourcesPhrase(d.candidates.length)}. ${f.q} считаем ${f.adj}?`,
    // Т1 приёмки: правило мерджа названо прямо — «авторитетен тот, кто раскрыл
    // объект изнутри». Без него «считать вклад весомее нельзя» звучит как отказ.
    why: "В обоих источниках есть описание, и в обоих случаях объекты атомарные."
      + " ArchMap считает авторитетным описание объекта-контейнера, у которого больше"
      + " дочерних сервисов. А здесь дочерних сервисов нет ни у одного.",
    ifLeft: `Если не отвечать: в проект попадёт значение «${value}» (${winner?.source_label ?? ""}), `
      + `${rest(d.candidates.length, "второе будет отброшено", "остальные будут отброшены")}.`,
  };
}

/** Окно, в котором идёт разбор: от него зависит одна сноска (4.3). */
export type QuestionMode = "create" | "into";

export function edgeTexts(e: ContainerEdgeOut, mode: QuestionMode = "create"): {
  title: string; context: string; why: string; ifLeft: string;
} {
  const начало = lastSegment(e.from_path);
  const конец = lastSegment(e.to_path);
  const пара = `«${начало} → ${конец}»`;
  // Контейнер в первом предложении — полным путём (тёзки-контейнеры законны), во
  // втором коротким именем: вопрос о компоненте читается, а не разбирается (Т2).
  const короткое = lastSegment(e.container_path);
  const n = e.components.length;
  return {
    title: e.end === "target"
      ? `Связь ${пара} приходит в контейнер «${e.container_path}». `
        + `С каким компонентом контейнера «${короткое}» связан объект «${начало}»?`
      : `Связь ${пара} выходит из контейнера «${e.container_path}». `
        + `С каким компонентом контейнера «${короткое}» связан объект «${конец}»?`,
    context: `внутри ${n} ${plural(n, ["компонент", "компонента", "компонентов"])}, считая вложенные`,
    why: "В одном источнике описаны дочерние компоненты объекта, а в другом не описаны."
      + " При слиянии источников такой объект станет контейнером. Но концы связей крепятся"
      + " к самостоятельным объектам, а не к контейнерам. Конец стрелки нужно перевесить"
      + " с контейнера на его дочерний объект.",
    // Единственная фраза разбора, зависящая от окна: в догрузке проект уже
    // создан, и обещать «после создания проекта» было бы ложью о моменте.
    ifLeft: `Если не отвечать: связь останется на контейнере и после ${
      mode === "into" ? "догрузки" : "создания проекта"
    } будет ждать в панели незавершённости — перевесить можно там.`,
  };
}

export function groupTexts(g: IsolatedGroupOut): {
  title: string; context: string; why: string; ifLeft: string;
} {
  const n = g.node_paths.length;
  const имена = g.node_paths.slice(0, 3).map((p) => `«${lastSegment(p)}»`).join(", ");
  return {
    // «У 1 объекта» / «У 4 объектов»: родительный падеж после «У» (Т5).
    title: `У ${n} ${plural(n, ["объекта", "объектов", "объектов"])} нет связей`
      + " с остальной схемой. Проведёте связь?",
    context: имена + (n > 3 ? ` и ещё ${n - 3}` : ""),
    why: "По источникам невозможно установить, как эти объекты связаны с остальной схемой.",
    ifLeft: "Если не отвечать: группа останется без связей, и панель незавершённости"
      + " покажет её как изолированную.",
  };
}

export function pairTexts(p: FuzzyPairOut): {
  title: string; context: string; why: string; ifLeft: string;
} {
  return {
    title: `«${lastSegment(p.a_path)}» и «${lastSegment(p.b_path)}» — похожие имена`
      + " из разных источников. Это один объект или разные?",
    context: `${p.a_source} и ${p.b_source}, оба ${p.where}`,
    why: "Имена похожи, но не совпадают. Автоматически склеивать нельзя:"
      + " ложная склейка хуже дубля.",
    ifLeft: "Если не отвечать: останутся два объекта, и при следующем импорте вопрос повторится.",
  };
}

/** Связи обоих — подпись первого варианта склейки и контекст её второго шага. */
export const pairEdges = (p: FuzzyPairOut): number => p.a_edges + p.b_edges;

// Заголовки и контекст ВТОРЫХ шагов (§4.4/§4.5): счётчик «вопрос N из M» они не
// меняют, поэтому живут тем же текстом, что и первый шаг.
export const NEW_EDGE_TITLE = "Связи объектов с остальной схемой";
export const NEW_EDGE_CONTEXT =
  "для каждого объекта укажите, с чем он связан; строку можно оставить пустой";
export const MERGE_TITLE = "Как назвать склеенный объект?";
export const mergeContext = (p: FuzzyPairOut): string =>
  `связи обоих (${pairEdges(p)}) перейдут на склеенный, второе имя перестанет использоваться`;
