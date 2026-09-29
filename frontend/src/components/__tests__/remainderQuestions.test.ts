// Чистая логика разбора остатка (Ф-E): список вопросов из превью, их тексты,
// прогресс, итог и payload применения.
//
// Что закрепляем: порядок видов (§4 ТЗ — от дешёвого решения к ответственному),
// формы слов по родам (спор схемы и спор канала звучат по-разному), число
// источников прописью, сноска «Если не отвечать» по ДЕФОЛТУ БЭКА, и главное —
// «как сейчас» не едет в применение: у ответа-дефолта и у молчания результат
// обязан совпадать байт-в-байт.
//
// Фикстуры типизированы схемами контракта: разъедется контракт — поймает tsc.
import { describe, it, expect } from "vitest";
import type {
  ContainerEdgeOut, FamilyConflictOut, FieldDisputeOut, FuzzyPairOut,
  IsolatedGroupOut, RemainderCandidateOut, RemainderOut,
} from "../../types";
import {
  answerLabel, answerState, buildQuestions, bulkAnswers, hasMineDisputes, progressMode,
  pruneAnswers, segments, summarize, toDecisions,
} from "../project/remainder/questions";
import type { Answers, Resolutions } from "../project/remainder/questions";
import { humanValue, sourcesPhrase } from "../project/remainder/questionText";

const кандидат = (over: Partial<RemainderCandidateOut> = {}): RemainderCandidateOut => ({
  origin: 0, origin_label: "1 · zabbix.yaml", source_label: "Из файла zabbix.yaml",
  value: "Сервер мониторинга", current: false, ...over,
});

const семья = (over: Partial<FamilyConflictOut> = {}): FamilyConflictOut => ({
  id: "doc|Zabbix/server|Опрос", family: "doc", node_path: "Zabbix / server", key: "Опрос",
  candidates: [
    { origin: 0, origin_label: "1 · zabbix.yaml", source_label: "Из файла zabbix.yaml", summary: "12 строк", body: "flowchart TD", truncated: false, current: false },
    { origin: 1, origin_label: "2 · plugin.zip", source_label: "Из архива plugin.zip", summary: "20 строк", body: "flowchart LR", truncated: false, current: false },
  ],
  default: "all", allow_all: true, ...over,
});

const поле = (over: Partial<FieldDisputeOut> = {}): FieldDisputeOut => ({
  id: "field|Zabbix/server|description", node_path: "Zabbix / server", field: "description",
  candidates: [кандидат(), кандидат({ origin: 1, source_label: "Из архива plugin.zip", value: "Ядро Zabbix" })],
  default: 0, ...over,
});

const связь = (over: Partial<ContainerEdgeOut> = {}): ContainerEdgeOut => ({
  id: "edge|Плагин/Датасорс|Zabbix||target", from_path: "Плагин / Датасорс", to_path: "Zabbix",
  label: "запросы", technology: "HTTP", end: "target", container_path: "Zabbix",
  components: [
    { path: "Zabbix / server", has_children: true },
    { path: "Zabbix / server / Поллер", has_children: false },
  ],
  ...over,
});

const группа = (over: Partial<IsolatedGroupOut> = {}): IsolatedGroupOut => ({
  id: "group|Плагин", node_paths: ["Плагин", "Плагин / Датасорс", "Плагин / Панель", "Плагин / Кэш"],
  ...over,
});

const пара = (over: Partial<FuzzyPairOut> = {}): FuzzyPairOut => ({
  id: "pair|Пользователь Zabbix|Пользователь", a_path: "Пользователь Zabbix", b_path: "Пользователь",
  a_source: "Из файла zabbix.yaml", b_source: "Из архива plugin.zip", a_edges: 2, b_edges: 1,
  where: "на верхнем уровне", a_current: false, b_current: false, ...over,
});

const остаток = (over: Partial<RemainderOut> = {}): RemainderOut => ({
  field_conflicts: [], container_edges: [], isolated_groups: [], fuzzy_pairs: [],
  unfixable: [], converted_warnings: [], node_paths: [], node_has_children: [], ...over,
});

const всё = () => buildQuestions({
  family_conflicts: [семья()],
  remainder: остаток({
    field_conflicts: [поле()], container_edges: [связь()],
    isolated_groups: [группа()], fuzzy_pairs: [пара()],
  }),
});

describe("buildQuestions: порядок и id", () => {
  it("идёт от дешёвого решения к ответственному", () => {
    expect(всё().map((q) => q.kind)).toEqual(["family", "field", "edge", "group", "pair"]);
  });

  it("берёт id элементов бэка, а не выдумывает свои", () => {
    expect(всё().map((q) => q.id)).toEqual([
      "doc|Zabbix/server|Опрос", "field|Zabbix/server|description",
      "edge|Плагин/Датасорс|Zabbix||target", "group|Плагин",
      "pair|Пользователь Zabbix|Пользователь",
    ]);
  });

  it("пустой остаток вопросов не даёт", () => {
    expect(buildQuestions({ family_conflicts: [], remainder: остаток() })).toEqual([]);
  });
});

describe("тексты спора содержимого (§4.1)", () => {
  const текст = (family: FamilyConflictOut["family"]) =>
    buildQuestions({ family_conflicts: [семья({ family })], remainder: остаток() })[0]!;

  it("схема логики — «объекта … схемы … Какую … правильной»", () => {
    expect(текст("doc").title).toBe(
      "У объекта «Опрос» в разных источниках разные схемы с одинаковым названием. Какую считаем правильной?");
    expect(текст("doc").why).toContain("Схемы разные (не совпадают побайтово)");
  });

  it("канал брокера — «канала … описания … Какое … правильным»", () => {
    expect(текст("channel").title).toBe(
      "У канала «Опрос» в разных источниках разные описания. Какое считаем правильным?");
    expect(текст("channel").why).toContain("Содержимое разное (не совпадают побайтово)");
  });

  it("параметр конфигурации — «параметра … значения»", () => {
    expect(текст("config").title).toContain("У параметра «Опрос» в разных источниках разные значения.");
  });

  it("спека и таблица — свои слова", () => {
    expect(текст("spec").title).toContain("разные спеки с одинаковым названием");
    expect(текст("table").title).toContain("разные таблицы с одинаковым названием");
  });

  it("дефолт «все» обещает нумерацию, дефолт-кандидат — имя источника", () => {
    expect(текст("doc").ifLeft).toBe(
      "Если не отвечать, то будут добавлены все схемы, и при добавлении им будут назначены номера.");
    const один = buildQuestions({
      family_conflicts: [семья({ default: "cand:1", allow_all: false })], remainder: остаток(),
    })[0]!;
    expect(один.ifLeft).toBe(
      "Если не отвечать, то в проект попадёт вариант «Из архива plugin.zip», а второй будет отброшен.");
  });

  it("трое спорщиков — «остальные будут отброшены»", () => {
    const трое = семья({
      default: "cand:0", allow_all: false,
      candidates: [...семья().candidates, {
        origin: 2, origin_label: "3 · grafana.yaml", source_label: "Из файла grafana.yaml",
        summary: "8 строк", body: "flowchart TD", truncated: false, current: false,
      }],
    });
    expect(buildQuestions({ family_conflicts: [трое], remainder: остаток() })[0]!.ifLeft)
      .toContain("остальные будут отброшены");
  });
});

describe("тексты спора полей (§4.2)", () => {
  const текст = (over: Partial<FieldDisputeOut>) =>
    buildQuestions({ family_conflicts: [], remainder: остаток({ field_conflicts: [поле(over)] }) })[0]!;

  it("описание, технология и роль спрягаются по-своему", () => {
    expect(текст({ field: "description" }).title).toBe(
      "У объекта «server» описание заполнено по-разному в двух источниках. Какое считаем правильным?");
    expect(текст({ field: "technology" }).title).toContain("технология указана по-разному");
    expect(текст({ field: "technology" }).title).toContain("Какую считаем правильной?");
    expect(текст({ field: "role" }).title).toContain("роль указана по-разному");
  });

  it("форма и статус — вопросы того же вида", () => {
    expect(текст({ field: "shape" }).title).toBe(
      "У объекта «server» форма указана по-разному в двух источниках. Какую считаем правильной?");
    expect(текст({ field: "status" }).title).toBe(
      "У объекта «server» статус указан по-разному в двух источниках. Какой считаем правильным?");
  });

  it("значения формы и статуса — человеческими словами (Р5)", () => {
    expect(humanValue("shape", "database")).toBe("База данных");
    expect(humanValue("status", "existing")).toBe("Существует");
    expect(humanValue("description", "Ядро Zabbix")).toBe("Ядро Zabbix");
    const q = текст({
      field: "shape",
      candidates: [кандидат({ value: "service" }), кандидат({ origin: 1, value: "database" })],
    });
    expect(q.ifLeft).toContain("в проект попадёт значение «Сервис»");
  });

  it("число источников — прописью до трёх", () => {
    expect(sourcesPhrase(2)).toBe("в двух источниках");
    expect(sourcesPhrase(3)).toBe("в трёх источниках");
    expect(sourcesPhrase(5)).toBe("в 5 источниках");
    const трое = текст({
      candidates: [кандидат(), кандидат({ origin: 1 }), кандидат({ origin: 2 })],
    });
    expect(трое.title).toContain("по-разному в трёх источниках");
    expect(трое.ifLeft).toContain(", а остальные будут отброшены.");
  });

  it("сноска называет значение, источник и судьбу второго", () => {
    expect(текст({}).ifLeft).toBe(
      "Если не отвечать, то в проект попадёт значение «Сервер мониторинга» (Из файла zabbix.yaml),"
      + " а второе будет отброшено.");
  });

  it("дефолт догрузки — кандидат живого проекта", () => {
    const q = текст({
      default: 1,
      candidates: [кандидат(), кандидат({ origin: 1, source_label: "Из проекта", value: "Моё", current: true })],
    });
    expect(q.ifLeft).toContain("значение «Моё» (Из проекта)");
  });
});

describe("тексты жестов (§4.3–4.5)", () => {
  it("связь в контейнер различает конец и начало", () => {
    const конец = buildQuestions({ family_conflicts: [], remainder: остаток({ container_edges: [связь()] }) })[0]!;
    expect(конец.title).toBe(
      "Связь «Датасорс → Zabbix» приходит в контейнер «Zabbix». "
      + "С каким компонентом контейнера «Zabbix» связан объект «Датасорс»?");
    expect(конец.context).toBe("внутри 2 компонента, считая вложенные");
    const начало = buildQuestions({
      family_conflicts: [], remainder: остаток({ container_edges: [связь({ end: "source" })] }),
    })[0]!;
    expect(начало.title).toContain(
      "выходит из контейнера «Zabbix». С каким компонентом контейнера «Zabbix» связан объект «Zabbix»?");
    expect(конец.why).toContain("Конец стрелки нужно перевесить с контейнера на его дочерний объект.");
  });

  it("сноска связи называет момент своего окна: создание или догрузка", () => {
    const создание = buildQuestions({
      family_conflicts: [], remainder: остаток({ container_edges: [связь()] }),
    })[0]!;
    expect(создание.ifLeft).toBe(
      "Если не отвечать, то связь останется на контейнере и после создания проекта"
      + " будет ждать в панели «Рекомендации». Перевесить её можно будет там.");
    const догрузка = buildQuestions({
      family_conflicts: [], remainder: остаток({ container_edges: [связь()] }), mode: "into",
    })[0]!;
    expect(догрузка.ifLeft).toBe(
      "Если не отвечать, то связь останется на контейнере и после догрузки"
      + " будет ждать в панели «Рекомендации». Перевесить её можно будет там.");
    // Остальные слова вопроса от окна не зависят: разбор один и тот же.
    expect(догрузка.title).toBe(создание.title);
    expect(догрузка.why).toBe(создание.why);
  });

  it("прочие сноски в догрузке не меняются", () => {
    const общие = (mode: "create" | "into") => buildQuestions({
      family_conflicts: [семья()],
      remainder: остаток({ isolated_groups: [группа()], fuzzy_pairs: [пара()] }),
      mode,
    }).map((q) => q.ifLeft);
    expect(общие("into")).toEqual(общие("create"));
  });

  it("изолированная группа перечисляет три имени и остаток", () => {
    const q = buildQuestions({ family_conflicts: [], remainder: остаток({ isolated_groups: [группа()] }) })[0]!;
    expect(q.title).toBe("У 4 объектов нет связей с остальной схемой. Проведёте связь?");
    expect(q.why).toBe("По источникам невозможно установить, как эти объекты связаны с остальной схемой.");
    expect(q.context).toBe("«Плагин», «Датасорс», «Панель» и ещё 1");
    expect(q.ifLeft).toBe(
      "Если не отвечать, то группа останется без связей, и в «Рекомендациях»"
      + " она появится как изолированная группа.");
  });

  it("похожие имена называют оба источника и место", () => {
    const q = buildQuestions({ family_conflicts: [], remainder: остаток({ fuzzy_pairs: [пара()] }) })[0]!;
    expect(q.title).toBe(
      "«Пользователь Zabbix» и «Пользователь» — похожие имена из разных источников."
      + " Это один объект или разные?");
    expect(q.context).toBe("Из файла zabbix.yaml и Из архива plugin.zip, оба на верхнем уровне");
    expect(q.ifLeft).toBe(
      "Если не отвечать, то останутся два объекта, и при следующем импорте вопрос повторится.");
  });

  it("ни одна сноска не опускает союз: «Если не отвечать, то …»", () => {
    const все = buildQuestions({
      family_conflicts: [семья(), семья({ id: "doc|b|x", default: "cand:0", allow_all: false })],
      remainder: остаток({
        field_conflicts: [поле()], container_edges: [связь()],
        isolated_groups: [группа()], fuzzy_pairs: [пара()],
      }),
    });
    expect(все.length).toBe(6);
    for (const q of все) expect(q.ifLeft).toMatch(/^Если не отвечать, то /);
  });
});

describe("прогресс", () => {
  const много = (n: number) => buildQuestions({
    family_conflicts: [], remainder: остаток({
      field_conflicts: Array.from({ length: n }, (_, i) => поле({ id: `f${i}` })),
    }),
  });

  it("14 вопросов — точки, 15 — полоса", () => {
    expect(progressMode(много(14).length)).toBe("dots");
    expect(progressMode(много(15).length)).toBe("segments");
  });

  it("сегменты считают отвеченное и «как сейчас» по видам", () => {
    const qs = всё();
    const answers: Answers = {
      "edge|Плагин/Датасорс|Zabbix||target": { kind: "edge", toPath: "Zabbix / server" },
      "group|Плагин": { kind: "keep" },
    };
    const s = segments(qs, answers, { "doc|Zabbix/server|Опрос": "cand:1" });
    expect(s.map((x) => x.caption)).toEqual([
      "Содержимое · 1/1", "Поля · 0/1", "В контейнер · 1/1", "Связи · 1/1", "Имена · 0/1",
    ]);
    expect(s[3]!.kept).toBe(1);
    expect(s.map((x) => x.first)).toEqual([0, 1, 2, 3, 4]);
  });
});

describe("состояние ответа и подпись в списке", () => {
  const qs = всё();
  const [content, field_, edge, group, pair] = qs;

  it("«как сейчас» — отдельное состояние, у спора содержимого его нет", () => {
    const answers: Answers = { "group|Плагин": { kind: "keep" }, "pair|Пользователь Zabbix|Пользователь": { kind: "diff" } };
    const res: Resolutions = { "doc|Zabbix/server|Опрос": "all" };
    expect(answerState(content!, answers, res)).toBe("answered");
    expect(answerState(field_!, answers, res)).toBe("none");
    expect(answerState(group!, answers, res)).toBe("keep");
    expect(answerState(pair!, answers, res)).toBe("keep");
  });

  it("подпись ответа — источник, значение, имя склейки", () => {
    const answers: Answers = {
      "field|Zabbix/server|description": { kind: "field", index: 1 },
      "edge|Плагин/Датасорс|Zabbix||target": { kind: "edge", toPath: "Zabbix / server / Поллер" },
      "pair|Пользователь Zabbix|Пользователь": { kind: "merge", name: "Оператор" },
    };
    expect(answerLabel(content!, {}, { "doc|Zabbix/server|Опрос": "all" })).toBe("добавить все");
    expect(answerLabel(content!, {}, { "doc|Zabbix/server|Опрос": "cand:1" })).toBe("Из архива plugin.zip");
    expect(answerLabel(content!, {}, {})).toBeNull();
    expect(answerLabel(field_!, answers, {})).toBe("Ядро Zabbix");
    expect(answerLabel(edge!, answers, {})).toBe("Поллер");
    expect(answerLabel(pair!, answers, {})).toBe("Оператор");
    // «Как сейчас» — такой же ответ: называется словами своего вида (П8).
    expect(answerLabel(group!, { "group|Плагин": { kind: "keep" } }, {})).toBe("как есть");
    expect(answerLabel(edge!, { [edge!.id]: { kind: "keep" } }, {})).toBe("на контейнере");
    expect(answerLabel(pair!, { [pair!.id]: { kind: "diff" } }, {})).toBe("разные объекты");
    expect(answerLabel(group!, {
      "group|Плагин": { kind: "new_edges", edges: [
        { fromPath: "Плагин", toPath: "Zabbix", label: "", tech: "" },
        { fromPath: "Плагин / Датасорс", toPath: "Zabbix", label: "", tech: "" },
      ] },
    }, {})).toBe("проведено связей 2");
  });
});

describe("итог разбора (§8)", () => {
  it("считает перевешенное, добавленное, склеенное и оставленное", () => {
    const qs = всё();
    const answers: Answers = {
      "field|Zabbix/server|description": { kind: "field", index: 1 },
      "edge|Плагин/Датасорс|Zabbix||target": { kind: "edge", toPath: "Zabbix / server" },
      "group|Плагин": { kind: "new_edges", edges: [
        { fromPath: "Плагин", toPath: "Zabbix", label: "", tech: "" },
        { fromPath: "Плагин / Датасорс", toPath: "Zabbix / server", label: "", tech: "" },
      ] },
      "pair|Пользователь Zabbix|Пользователь": { kind: "diff" },
    };
    // added считает СВЯЗИ, а не отвеченные вопросы: одна группа — несколько связей.
    expect(summarize(qs, answers, { "doc|Zabbix/server|Опрос": "cand:0" })).toEqual({
      rewired: 1, added: 2, merged: 0, fields: 1, kept: 1, unanswered: 0,
    });
  });

  it("без резолюций спор содержимого считается неотвеченным", () => {
    expect(summarize(всё(), {}).unanswered).toBe(5);
    expect(summarize(всё(), {}, { "doc|Zabbix/server|Опрос": "all" }).unanswered).toBe(4);
  });
});

describe("payload применения", () => {
  const qs = всё();

  it("едут только содержательные ответы, в формах контракта", () => {
    const answers: Answers = {
      "field|Zabbix/server|description": { kind: "field", index: 1 },
      "edge|Плагин/Датасорс|Zabbix||target": { kind: "edge", toPath: "Zabbix / server / Поллер" },
      "group|Плагин": {
        kind: "new_edges",
        edges: [{ fromPath: "Плагин / Датасорс", toPath: "Zabbix / server", label: "метрики", tech: "HTTP" }],
      },
      "pair|Пользователь Zabbix|Пользователь": { kind: "merge", name: "Оператор" },
    };
    expect(toDecisions(qs, answers)).toEqual({
      fields: { "field|Zabbix/server|description": 1 },
      edges: { "edge|Плагин/Датасорс|Zabbix||target": { to_path: "Zabbix / server / Поллер" } },
      new_edges: [{
        group_id: "group|Плагин", from_path: "Плагин / Датасорс", to_path: "Zabbix / server",
        label: "метрики", tech: "HTTP",
      }],
      merges: { "pair|Пользователь Zabbix|Пользователь": { name: "Оператор" } },
    });
  });

  it("«как сейчас» и пустота дают null — результат тот же, что без решений", () => {
    expect(toDecisions(qs, {})).toBeNull();
    expect(toDecisions(qs, {
      "edge|Плагин/Датасорс|Zabbix||target": { kind: "keep" },
      "group|Плагин": { kind: "keep" },
      "pair|Пользователь Zabbix|Пользователь": { kind: "diff" },
    })).toBeNull();
  });

  it("ответы на исчезнувшие вопросы в payload не попадают", () => {
    expect(toDecisions([], { "group|Плагин": { kind: "merge", name: "X" } })).toBeNull();
  });
});

describe("протухшие ответы", () => {
  it("отбрасываются, а нетронутая карта возвращается той же ссылкой", () => {
    const qs = всё();
    const answers: Answers = {
      "group|Плагин": { kind: "keep" },
      "было-да-сплыло": { kind: "diff" },
    };
    expect(Object.keys(pruneAnswers(answers, qs))).toEqual(["group|Плагин"]);
    const живые: Answers = { "group|Плагин": { kind: "keep" } };
    expect(pruneAnswers(живые, qs)).toBe(живые);
    expect(pruneAnswers({}, [])).toEqual({});
  });
});

describe("массовые ответы догрузки (§7, Р10)", () => {
  const свои = () => buildQuestions({
    family_conflicts: [семья({
      default: "cand:0", allow_all: false,
      candidates: [
        { origin: 0, origin_label: "Текущий проект", source_label: "Из проекта", summary: "12 строк", body: "", truncated: false, current: true },
        { origin: 1, origin_label: "1 · plugin.zip", source_label: "Из архива plugin.zip", summary: "20 строк", body: "", truncated: false, current: false },
      ],
    })],
    remainder: остаток({
      field_conflicts: [поле({
        default: 0,
        candidates: [кандидат({ source_label: "Из проекта", value: "Моё", current: true }), кандидат({ origin: 1, value: "Из архива" })],
      }), поле({ id: "field|чужое|role", field: "role" })],
      container_edges: [связь()], isolated_groups: [группа()], fuzzy_pairs: [пара()],
    }),
  });

  it("«взять из архивов» отвечает только спорам с живым кандидатом", () => {
    const qs = свои();
    expect(hasMineDisputes(qs)).toBe(true);
    const было = { answers: {} as Answers, resolutions: {} as Resolutions };
    const { answers, resolutions } = bulkAnswers(qs, false, было);
    expect(resolutions).toEqual({ "doc|Zabbix/server|Опрос": "cand:1" });
    expect(answers).toEqual({ "field|Zabbix/server|description": { kind: "field", index: 1 } });
  });

  it("«оставить моё» снимает резолюцию и выбирает живого кандидата в поле", () => {
    const qs = свои();
    const было = {
      answers: {
        "field|Zabbix/server|description": { kind: "field", index: 1 },
        "group|Плагин": { kind: "keep" },
      } as Answers,
      resolutions: { "doc|Zabbix/server|Опрос": "cand:1" } as Resolutions,
    };
    const { answers, resolutions } = bulkAnswers(qs, true, было);
    expect(resolutions).toEqual({});
    expect(answers["field|Zabbix/server|description"]).toEqual({ kind: "field", index: 0 });
    // Жесты массовым ответом не закрываются: это работа, а не конфликт.
    expect(answers["group|Плагин"]).toEqual({ kind: "keep" });
    expect(answers["edge|Плагин/Датасорс|Zabbix||target"]).toBeUndefined();
    expect(answers["pair|Пользователь Zabbix|Пользователь"]).toBeUndefined();
  });

  it("спор двух архивов между собой массовой кнопкой не трогается", () => {
    const qs = свои();
    const { answers } = bulkAnswers(qs, false, { answers: {}, resolutions: {} });
    expect(answers["field|чужое|role"]).toBeUndefined();
    expect(hasMineDisputes(buildQuestions({
      family_conflicts: [], remainder: остаток({ field_conflicts: [поле()] }),
    }))).toBe(false);
  });
});
