// Слова разбора остатка: заголовки вопросов, короткие темы для списка «Все вопросы»,
// «почему возник вопрос» и сноски «Если не отвечать, то …» (§4 ТЗ «Остаток слияния — разбор вопросами» + раздел
// «Тексты архитектора» задания Ф2; союз «то» не опускается — правка Ф2г). Отдельный модуль от questions.ts: там сборка списка и
// подсчёты, здесь — только текст, формы по родам и склонения. Тексты ФИНАЛЬНЫЕ:
// правятся вместе с ТЗ, а не по вкусу.
import type {
  ComponentOut, ContainerEdgeOut, FamilyConflictOut, FieldDisputeOut,
  FuzzyPairOut, IsolatedGroupOut, NodeElement, NodeShape, NodeStatus,
} from "../../../types";
import { plural } from "../../../ui/plural";
import { STATUS_META } from "../../graph/colors";
import { ELEMENT_LABEL, SHAPE_LABEL } from "../../nodeTerms";

/** Последний сегмент пути: «Grafana / Сервер Grafana» → «Сервер Grafana». */
export const lastSegment = (path: string): string => path.split(" / ").pop() ?? path;

const cap = (s: string): string => s.charAt(0).toUpperCase() + s.slice(1);

/**
 * Подпись источника посреди фразы — со строчной: бэк присылает её с заглавной («Из файла
 * a.yaml», «Из проекта»), как подпись варианта. В кавычках названием варианта и в начале
 * строки заглавная остаётся.
 */
const lowerFirst = (s: string): string => s.charAt(0).toLowerCase() + s.slice(1);

/**
 * Число файлов словами: «в двух файлах» / «в трёх файлах» / «в 5 файлах»
 * (до 2026-10-17 — «источниках»: слово отдано источнику объекта). Двойка и тройка прописью — так написаны тексты ТЗ (§4.2), и
 * цифра «2» посреди фразы выглядела бы счётчиком, а не количеством спорщиков.
 */
export function sourcesPhrase(n: number): string {
  if (n === 2) return "в двух файлах";
  if (n === 3) return "в трёх файлах";
  return `в ${n} файлах`;
}


/**
 * Значение поля человеческими словами (Р5 задания): форма, статус и элемент
 * архитектуры приезжают кодами контракта («service», «planned», «container») — в
 * вопросе они читались бы как внутренности. Прочие поля показываются как есть.
 */
export function humanValue(field: string, value: string): string {
  if (field === "shape" && value in SHAPE_LABEL) return SHAPE_LABEL[value as NodeShape];
  if (field === "status" && value in STATUS_META) return STATUS_META[value as NodeStatus].label;
  if (field === "element" && value in ELEMENT_LABEL) return ELEMENT_LABEL[value as NodeElement];
  return value;
}

// Формы по родам для спора содержимого (§4.1). what — что разное у объекта-владельца
// (ключ записи в кавычках; у спецификации ключа нет: она у объекта одна), diff — первая
// половина «почему», topic — предмет спора в теме списка «Все вопросы» (фаза 8б).
interface FamilyForms {
  what: (key: string) => string; topic: (key: string) => string;
  all: string; one: string; adj: string; diff: string;
}
const FAMILY: Record<FamilyConflictOut["family"], FamilyForms> = {
  doc: { what: (k) => `схемы логики «${k}»`, topic: (k) => `схема логики «${k}»`, all: "схемы",
    one: "какую", adj: "правильной", diff: "Схемы разные" },
  spec: { what: () => "спецификации OpenAPI", topic: () => "спецификация OpenAPI", all: "спецификации",
    one: "какую", adj: "правильной", diff: "Содержимое разное" },
  table: { what: (k) => `таблицы «${k}»`, topic: (k) => `таблица «${k}»`, all: "таблицы",
    one: "какую", adj: "правильной", diff: "Содержимое разное" },
  channel: { what: (k) => `описания канала «${k}»`, topic: (k) => `канал «${k}»`, all: "описания",
    one: "какое", adj: "правильным", diff: "Содержимое разное" },
  config: { what: (k) => `значения параметра «${k}»`, topic: (k) => `параметр «${k}»`, all: "значения",
    one: "какое", adj: "правильным", diff: "Содержимое разное" },
};

/**
 * Спор с живым проектом (догрузка, фаза 8б): число архивных кандидатов, если среди
 * кандидатов есть проект (current); null — проекта нет, спорят файлы. От этого зависят
 * слова спора: «в проекте и в архиве» вместо «в двух файлах» и судьба отброшенного.
 */
function archivesVsProject(candidates: { current: boolean }[]): number | null {
  if (!candidates.some((k) => k.current)) return null;
  return candidates.filter((k) => !k.current).length;
}

/** «в проекте и в архиве» / «в проекте и в архивах» по числу архивных кандидатов. */
const projectAndArchives = (archives: number): string =>
  archives > 1 ? "в проекте и в архивах" : "в проекте и в архиве";

/**
 * Где разошлись записи: «в разных файлах», а в догрузке, где один кандидат — живой проект,
 * «в проекте и в архиве» («в архивах», когда архивных кандидатов несколько).
 */
function familyWhere(c: FamilyConflictOut): string {
  const archives = archivesVsProject(c.candidates);
  return archives === null ? "в разных файлах" : projectAndArchives(archives);
}

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

/** Индекс кандидата-дефолта спора содержимого; −1 — дефолт «взять все». */
export const familyDefaultIndex = (c: FamilyConflictOut): number =>
  c.default.startsWith("cand:") ? Number(c.default.slice(5)) : -1;

// «второй будет отброшен» против «остальные будут отброшены»: пара спорщиков —
// самый частый случай, и множественное число в нём звучит как «их много».
const rest = (n: number, one: string, many: string): string => (n === 2 ? one : many);

export function familyTexts(c: FamilyConflictOut): {
  title: string; topic: string; why: string; ifLeft: string;
} {
  const f = FAMILY[c.family];
  const i = familyDefaultIndex(c);
  const winner = c.candidates[i];
  const archives = archivesVsProject(c.candidates);
  return {
    topic: `${lastSegment(c.node_path)}, ${f.topic(c.key)}`,
    // Владелец записи назван (Р фазы 8а): ключ один у многих объектов, «Создание заказа»
    // или «openapi» сами по себе объект не называют.
    title: `У объекта «${lastSegment(c.node_path)}» ${familyWhere(c)} разные ${f.what(c.key)}. `
      + `${cap(f.one)} считаем ${f.adj}?`,
    why: `${f.diff} (отличаются хотя бы одним символом), а названия одинаковые. `
      + `Непонятно, ${f.one} считать ${f.adj}.`,
    ifLeft: winner === undefined
      ? `Если не отвечать, то будут добавлены все ${f.all}, и при добавлении им будут назначены номера.`
      // В догрузке по умолчанию остаётся вариант проекта: он не «попадает» в проект, а остаётся.
      : winner.current && archives !== null
        ? "Если не отвечать, то в проекте останется прежний вариант, а "
          + `${archives > 1 ? "варианты из архивов будут отброшены" : "вариант из архива будет отброшен"}.`
        : `Если не отвечать, то в проект попадёт вариант «${winner.source_label}», `
          + `а ${rest(c.candidates.length, "второй будет отброшен", "остальные будут отброшены")}.`,
  };
}

// Формы по полям (§4.2 + «Тексты архитектора»). Поле вне карты — запасная форма
// ТЗ: «{поле в нижнем регистре} заполнено»; name — поле в теме списка (фаза 8б).
interface FieldForms { name: string; what: string; q: string; adj: string }
const FIELD: Record<string, FieldForms> = {
  description: { name: "описание", what: "описание заполнено", q: "Какое", adj: "правильным" },
  technology: { name: "технология", what: "технология указана", q: "Какую", adj: "правильной" },
  role: { name: "роль", what: "роль указана", q: "Какую", adj: "правильной" },
  shape: { name: "форма", what: "форма указана", q: "Какую", adj: "правильной" },
  status: { name: "статус", what: "статус указан", q: "Какой", adj: "правильным" },
  element: { name: "элемент архитектуры", what: "элемент архитектуры указан", q: "Какой", adj: "правильным" },
};

export function fieldTexts(d: FieldDisputeOut): {
  title: string; topic: string; why: string; ifLeft: string;
} {
  const f = FIELD[d.field] ?? {
    name: d.field.toLowerCase(), what: `${d.field.toLowerCase()} заполнено`, q: "Какое", adj: "правильным",
  };
  const winner = d.candidates[d.default];
  const value = winner ? humanValue(d.field, winner.value) : "";
  const archives = archivesVsProject(d.candidates);
  return {
    topic: `${lastSegment(d.node_path)}, ${f.name}`,
    title: `У объекта «${lastSegment(d.node_path)}» ${f.what} по-разному `
      + `${archives === null ? sourcesPhrase(d.candidates.length) : projectAndArchives(archives)}.`
      + ` ${f.q} считаем ${f.adj}?`,
    // Правило мерджа названо прямо и верно для любого поля и любого числа файлов (фаза
    // 8а): раньше пояснение говорило «описание» про технологию и «в обоих» при трёх. В
    // догрузке спорят проект и архив (фаза 8б): живой проект входит в слияние первым входом
    // по тому же правилу (backend/app/import_merge.py, _decide).
    why: archives === null
      ? "ArchMap обычно берёт значение из того файла, где объект описан подробнее."
        + " Здесь файлы описывают его одинаково подробно."
      : "ArchMap обычно берёт значение оттуда, где объект описан подробнее."
        + ` Здесь ${archives > 1 ? "проект и архивы" : "проект и архив"} описывают его одинаково подробно.`,
    ifLeft: winner?.current === true && archives !== null
      ? `Если не отвечать, то в проекте останется значение «${value}», а `
        + `${archives > 1 ? "значения из архивов будут отброшены" : "значение из архива будет отброшено"}.`
      : `Если не отвечать, то в проект попадёт значение «${value}» (${lowerFirst(winner?.source_label ?? "")}), `
        + `а ${rest(d.candidates.length, "второе будет отброшено", "остальные будут отброшены")}.`,
  };
}

/** Окно, в котором идёт разбор: от него зависит одна сноска (4.3). */
export type QuestionMode = "create" | "into";

/**
 * Тег объекта с вложенными в списках разбора: «система» или «контейнер» по
 * действующему элементу из ответа сервера (составной компонент — редкость — зовётся
 * контейнером, как в словах вопроса о связи). Без элемента (ответ прежнего сервера) —
 * «система». У листа тега нет.
 */
export function nestedTag(x: ComponentOut): string | undefined {
  if (!x.has_children) return undefined;
  return x.element_effective === "container" || x.element_effective === "component"
    ? "контейнер" : "система";
}

/** Конец связи — система (иначе контейнер): от этого зависят слова вопроса 4.3. */
export const endIsSystem = (e: ContainerEdgeOut): boolean => e.container_element === "system";

// Подписи вариантов, которые действуют без ответа: одни и те же слова на самом варианте и
// в списке «Все вопросы» (там вариант без ответа подписан тихим цветом).
export const ADD_ALL = "Добавить все";
export const KEEP_GROUP = "Оставить как есть";
export const DIFF_PAIR = "Разные объекты";
/** «Оставить на системе» / «Оставить на контейнере»; на варианте за ним идёт путь в кавычках. */
export const keepEdgeLabel = (e: ContainerEdgeOut): string =>
  `Оставить на ${endIsSystem(e) ? "системе" : "контейнере"}`;

export function edgeTexts(e: ContainerEdgeOut, mode: QuestionMode = "create"): {
  title: string; topic: string; context: string; why: string; ifLeft: string;
} {
  const начало = lastSegment(e.from_path);
  const конец = lastSegment(e.to_path);
  const пара = `«${начало} → ${конец}»`;
  // Конец в первом предложении — полным путём (тёзки законны), во втором коротким
  // именем: вопрос о вложенном объекте читается, а не разбирается (Т2).
  const короткое = lastSegment(e.container_path);
  const n = e.components.length;
  // Единственная фраза разбора, зависящая от окна: в догрузке проект уже
  // создан, и обещать «после создания проекта» было бы ложью о моменте.
  const момент = mode === "into" ? "догрузки" : "создания проекта";
  // «его рекомендации» — только после «создания проекта» (решение владельца 2026-11-01):
  // в догрузке слова «проекта» перед сноской нет, и «его» было бы не к чему отнести.
  const куда = mode === "into" ? "рекомендации проекта" : "его рекомендации";
  const topic = `Связь ${пара}`;
  if (endIsSystem(e)) {
    return {
      topic,
      title: e.end === "target"
        ? `Связь ${пара} приходит в систему «${e.container_path}». `
          + `С каким объектом внутри системы «${короткое}» связан объект «${начало}»?`
        : `Связь ${пара} выходит из системы «${e.container_path}». `
          + `С каким объектом внутри системы «${короткое}» связан объект «${конец}»?`,
      context: `внутри ${n} ${plural(n, ["объекта", "объектов", "объектов"])}, считая вложенные`,
      // Верно и при одном файле (фаза 8а): прежнее «в одном файле…, а в другом» им не было.
      why: `Связь указана на системе «${короткое}», а вызовы принимают объекты внутри неё.`
        + " Конец связи нужно перенести на один из них.",
      ifLeft: `Если не отвечать, то связь останется на системе и после ${момент} попадёт`
        + ` в ${куда}. Там её можно будет перенести.`,
    };
  }
  return {
    topic,
    title: e.end === "target"
      ? `Связь ${пара} приходит в контейнер «${e.container_path}». `
        + `С каким компонентом контейнера «${короткое}» связан объект «${начало}»?`
      : `Связь ${пара} выходит из контейнера «${e.container_path}». `
        + `С каким компонентом контейнера «${короткое}» связан объект «${конец}»?`,
    context: `внутри ${n} ${plural(n, ["компонент", "компонента", "компонентов"])}, считая вложенные`,
    why: `Связь указана на контейнере «${короткое}», а вызовы принимают его компоненты.`
      + " Конец связи нужно перенести на один из них.",
    ifLeft: `Если не отвечать, то связь останется на контейнере и после ${момент} попадёт`
      + ` в ${куда}. Там её можно будет перенести.`,
  };
}

export function groupTexts(g: IsolatedGroupOut): {
  title: string; topic: string; context: string; why: string; ifLeft: string;
} {
  const n = g.node_paths.length;
  const имена = g.node_paths.slice(0, 3).map((p) => `«${lastSegment(p)}»`).join(", ");
  return {
    topic: `${n} ${plural(n, ["объект", "объекта", "объектов"])} без связей`,
    // «У 1 объекта» / «У 4 объектов»: родительный падеж после «У» (Т5).
    title: `У ${n} ${plural(n, ["объекта", "объектов", "объектов"])} нет связей`
      + " с остальной схемой. Проведёте связь?",
    context: имена + (n > 3 ? ` и ещё ${n - 3}` : ""),
    why: "По файлам невозможно установить, как эти объекты связаны с остальной схемой.",
    ifLeft: "Если не отвечать, то группа останется без связей и попадёт в рекомендации"
      + " проекта как изолированная группа.",
  };
}

export function pairTexts(p: FuzzyPairOut, mode: QuestionMode = "create"): {
  title: string; topic: string; context: string; why: string; ifLeft: string;
} {
  // В догрузке вопрос повторится при следующей догрузке, а не «импорте» (фаза 8а).
  const следующий = mode === "into" ? "следующей догрузке" : "следующем импорте";
  // Одно из имён — живой проект (догрузка): спорят не файлы, а проект и архив (фаза 8б).
  const где = p.a_current || p.b_current ? "в проекте и в архиве" : "из разных файлов";
  return {
    topic: `«${lastSegment(p.a_path)}» и «${lastSegment(p.b_path)}»`,
    title: `«${lastSegment(p.a_path)}» и «${lastSegment(p.b_path)}» — похожие имена`
      + ` ${где}. Это один объект или разные?`,
    // Строка контекста — фрагмент со строчной, как «внутри 2 объектов, считая вложенные».
    context: `${lowerFirst(p.a_source)} и ${lowerFirst(p.b_source)}, оба ${p.where}`,
    why: "Имена похожи, но не совпадают, поэтому ArchMap не объединяет их сам."
      + " Ошибочное объединение хуже дубля.",
    ifLeft: `Если не отвечать, то останутся два объекта, и при ${следующий} вопрос повторится.`,
  };
}

/** Связи обоих — подпись первого варианта склейки и контекст её второго шага. */
export const pairEdges = (p: FuzzyPairOut): number => p.a_edges + p.b_edges;

// Заголовки и контекст ВТОРЫХ шагов (§4.4/§4.5): счётчик «вопрос N из M» они не
// меняют, поэтому живут тем же текстом, что и первый шаг.
export const NEW_EDGE_TITLE = "Связи объектов с остальной схемой";
export const NEW_EDGE_CONTEXT =
  "для каждого объекта укажите, с чем он связан; строку можно оставить пустой";
export const MERGE_TITLE = "Как назвать объединённый объект?";
export const mergeContext = (p: FuzzyPairOut): string =>
  `связи обоих (${pairEdges(p)}) перейдут на объединённый, второе имя перестанет использоваться`;
