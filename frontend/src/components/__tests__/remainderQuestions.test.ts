// Чистая логика разбора остатка (Ф-E): список вопросов из превью, их тексты,
// подписи ответов и вариантов по умолчанию, итог и payload применения.
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
  answerLabel, answerState, buildQuestions, bulkAnswers, defaultLabel, hasMineDisputes,
  pruneAnswers, summarize, toDecisions,
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
  container_element: "container",
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
  unfixable: [], converted_warnings: [], node_paths: [], node_has_children: [], node_elements: [], ...over,
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

describe("тексты спора содержимого (§4.1, фаза 8а)", () => {
  const текст = (family: FamilyConflictOut["family"], over: Partial<FamilyConflictOut> = {}) =>
    buildQuestions({ family_conflicts: [семья({ family, ...over })], remainder: остаток() })[0]!;

  it("называет владельца записи и ключ: пять семей", () => {
    expect(текст("doc").title).toBe(
      "У объекта «server» в разных файлах разные схемы логики «Опрос». Какую считаем правильной?");
    expect(текст("table", { key: "order_items" }).title).toBe(
      "У объекта «server» в разных файлах разные таблицы «order_items». Какую считаем правильной?");
    expect(текст("channel", { key: "orders.events" }).title).toBe(
      "У объекта «server» в разных файлах разные описания канала «orders.events». Какое считаем правильным?");
    expect(текст("config", { key: "MAX_ITEMS" }).title).toBe(
      "У объекта «server» в разных файлах разные значения параметра «MAX_ITEMS». Какое считаем правильным?");
    // У спецификации ключ «openapi» объектом не называется: она у объекта одна.
    expect(текст("spec", { key: "openapi" }).title).toBe(
      "У объекта «server» в разных файлах разные спецификации OpenAPI. Какую считаем правильной?");
  });

  it("в догрузке с кандидатом «Из проекта» — «в проекте и в архиве»", () => {
    const из = (n: number) => семья({
      candidates: [
        { origin: 0, origin_label: "Текущий проект", source_label: "Из проекта", summary: "", body: "", truncated: false, current: true },
        ...Array.from({ length: n }, (_, i) => ({
          origin: i + 1, origin_label: `${i + 1} · a${i}.zip`, source_label: `Из архива a${i}.zip`,
          summary: "", body: "", truncated: false, current: false,
        })),
      ],
    });
    expect(buildQuestions({ family_conflicts: [из(1)], remainder: остаток(), mode: "into" })[0]!.title).toBe(
      "У объекта «server» в проекте и в архиве разные схемы логики «Опрос». Какую считаем правильной?");
    // Архивных кандидатов несколько — «в архивах».
    expect(buildQuestions({ family_conflicts: [из(2)], remainder: остаток(), mode: "into" })[0]!.title)
      .toContain("в проекте и в архивах разные");
  });

  it("в догрузке по умолчанию вариант проекта: он остаётся, архивный отбрасывается (фаза 8б)", () => {
    const из = (n: number) => семья({
      default: "cand:0", allow_all: false,
      candidates: [
        { origin: 0, origin_label: "Текущий проект", source_label: "Из проекта", summary: "", body: "", truncated: false, current: true },
        ...Array.from({ length: n }, (_, i) => ({
          origin: i + 1, origin_label: `${i + 1} · a${i}.zip`, source_label: `Из архива a${i}.zip`,
          summary: "", body: "", truncated: false, current: false,
        })),
      ],
    });
    const сноска = (n: number) =>
      buildQuestions({ family_conflicts: [из(n)], remainder: остаток(), mode: "into" })[0]!.ifLeft;
    expect(сноска(1)).toBe(
      "Если не отвечать, то в проекте останется прежний вариант, а вариант из архива будет отброшен.");
    expect(сноска(2)).toBe(
      "Если не отвечать, то в проекте останется прежний вариант, а варианты из архивов будут отброшены.");
  });

  it("«почему» — прежнее", () => {
    expect(текст("doc").why).toContain("Схемы разные (отличаются хотя бы одним символом)");
    expect(текст("channel").why).toContain("Содержимое разное (отличаются хотя бы одним символом)");
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

  it("правило авторитетности — одно на все поля и любое число файлов (фаза 8а)", () => {
    const пояснение = "ArchMap обычно берёт значение из того файла, где объект описан подробнее."
      + " Здесь файлы описывают его одинаково подробно.";
    for (const field of ["description", "technology", "shape", "status", "element"] as const) {
      expect(текст({ field }).why).toBe(пояснение);
    }
    expect(текст({ candidates: [кандидат(), кандидат({ origin: 1 }), кандидат({ origin: 2 })] }).why)
      .toBe(пояснение);
  });

  it("описание, технология и роль спрягаются по-своему", () => {
    expect(текст({ field: "description" }).title).toBe(
      "У объекта «server» описание заполнено по-разному в двух файлах. Какое считаем правильным?");
    expect(текст({ field: "technology" }).title).toContain("технология указана по-разному");
    expect(текст({ field: "technology" }).title).toContain("Какую считаем правильной?");
    expect(текст({ field: "role" }).title).toContain("роль указана по-разному");
  });

  it("форма и статус — вопросы того же вида", () => {
    expect(текст({ field: "shape" }).title).toBe(
      "У объекта «server» форма указана по-разному в двух файлах. Какую считаем правильной?");
    expect(текст({ field: "status" }).title).toBe(
      "У объекта «server» статус указан по-разному в двух файлах. Какой считаем правильным?");
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

  it("элемент архитектуры — тот же вопрос, значения словами", () => {
    expect(humanValue("element", "system")).toBe("Система");
    expect(humanValue("element", "container")).toBe("Контейнер");
    const q = текст({
      id: "field|Ярмарка/orders|element", node_path: "Ярмарка / orders", field: "element",
      candidates: [кандидат({ value: "system" }), кандидат({ origin: 1, value: "container" })],
    });
    expect(q.title).toBe(
      "У объекта «orders» элемент архитектуры указан по-разному в двух файлах. "
      + "Какой считаем правильным?");
    expect(q.ifLeft).toContain("в проект попадёт значение «Система»");
  });

  it("число источников — прописью до трёх", () => {
    expect(sourcesPhrase(2)).toBe("в двух файлах");
    expect(sourcesPhrase(3)).toBe("в трёх файлах");
    expect(sourcesPhrase(5)).toBe("в 5 файлах");
    const трое = текст({
      candidates: [кандидат(), кандидат({ origin: 1 }), кандидат({ origin: 2 })],
    });
    expect(трое.title).toContain("по-разному в трёх файлах");
    expect(трое.ifLeft).toContain(", а остальные будут отброшены.");
  });

  it("сноска называет значение, источник со строчной и судьбу второго", () => {
    expect(текст({}).ifLeft).toBe(
      "Если не отвечать, то в проект попадёт значение «Сервер мониторинга» (из файла zabbix.yaml),"
      + " а второе будет отброшено.");
  });

  it("дефолт догрузки — кандидат живого проекта: спорят проект и архив (фаза 8б)", () => {
    const q = текст({
      default: 1,
      candidates: [кандидат(), кандидат({ origin: 1, source_label: "Из проекта", value: "Моё", current: true })],
    });
    expect(q.title).toBe(
      "У объекта «server» описание заполнено по-разному в проекте и в архиве. Какое считаем правильным?");
    expect(q.why).toBe("ArchMap обычно берёт значение оттуда, где объект описан подробнее."
      + " Здесь проект и архив описывают его одинаково подробно.");
    expect(q.ifLeft).toBe(
      "Если не отвечать, то в проекте останется значение «Моё», а значение из архива будет отброшено.");
  });

  it("догрузка с несколькими архивами — «в архивах», «проект и архивы», «значения из архивов»", () => {
    const q = текст({
      field: "technology", default: 0,
      candidates: [
        кандидат({ source_label: "Из проекта", value: "Kafka", current: true }),
        кандидат({ origin: 1, source_label: "Из архива a.zip", value: "Redpanda" }),
        кандидат({ origin: 2, source_label: "Из архива b.zip", value: "Apache Kafka" }),
      ],
    });
    expect(q.title).toBe(
      "У объекта «server» технология указана по-разному в проекте и в архивах. Какую считаем правильной?");
    expect(q.why).toContain("Здесь проект и архивы описывают его одинаково подробно.");
    expect(q.ifLeft).toBe(
      "Если не отвечать, то в проекте останется значение «Kafka», а значения из архивов будут отброшены.");
  });

  it("в догрузке по умолчанию архивный кандидат — сноска прежняя, заголовок о проекте и архиве", () => {
    const q = текст({
      default: 0,
      candidates: [кандидат({ source_label: "Из архива a.zip", value: "Новое" }), кандидат({ origin: 1, source_label: "Из проекта", value: "Моё", current: true })],
    });
    expect(q.title).toContain("по-разному в проекте и в архиве.");
    expect(q.ifLeft).toBe(
      "Если не отвечать, то в проект попадёт значение «Новое» (из архива a.zip), а второе будет отброшено.");
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
    // Пояснение верно и при одном файле (фаза 8а): ни «в одном файле», ни «в другом».
    expect(конец.why).toBe(
      "Связь указана на контейнере «Zabbix», а вызовы принимают его компоненты."
      + " Конец связи нужно перенести на один из них.");
  });

  it("связь в систему — словами системы: вложенные объекты, «оставить на системе»", () => {
    const система = связь({ container_element: "system" });
    const конец = buildQuestions({ family_conflicts: [], remainder: остаток({ container_edges: [система] }) })[0]!;
    expect(конец.title).toBe(
      "Связь «Датасорс → Zabbix» приходит в систему «Zabbix». "
      + "С каким объектом внутри системы «Zabbix» связан объект «Датасорс»?");
    expect(конец.context).toBe("внутри 2 объектов, считая вложенные");
    expect(конец.why).toBe(
      "Связь указана на системе «Zabbix», а вызовы принимают объекты внутри неё."
      + " Конец связи нужно перенести на один из них.");
    expect(конец.ifLeft).toBe(
      "Если не отвечать, то связь останется на системе и после создания проекта"
      + " попадёт в его рекомендации. Там её можно будет перенести.");
    const начало = buildQuestions({
      family_conflicts: [], remainder: остаток({ container_edges: [{ ...система, end: "source" }] }),
      mode: "into",
    })[0]!;
    expect(начало.title).toBe(
      "Связь «Датасорс → Zabbix» выходит из системы «Zabbix». "
      + "С каким объектом внутри системы «Zabbix» связан объект «Zabbix»?");
    expect(начало.ifLeft).toBe(
      "Если не отвечать, то связь останется на системе и после догрузки"
      + " попадёт в рекомендации проекта. Там её можно будет перенести.");
    expect(answerLabel(начало, { [начало.id]: { kind: "keep" } }, {})).toBe("Оставить на системе");
    expect(defaultLabel(начало)).toBe("Оставить на системе");
  });

  it("сноска связи называет момент своего окна: создание или догрузка", () => {
    const создание = buildQuestions({
      family_conflicts: [], remainder: остаток({ container_edges: [связь()] }),
    })[0]!;
    expect(создание.ifLeft).toBe(
      "Если не отвечать, то связь останется на контейнере и после создания проекта"
      + " попадёт в его рекомендации. Там её можно будет перенести.");
    const догрузка = buildQuestions({
      family_conflicts: [], remainder: остаток({ container_edges: [связь()] }), mode: "into",
    })[0]!;
    expect(догрузка.ifLeft).toBe(
      "Если не отвечать, то связь останется на контейнере и после догрузки"
      + " попадёт в рекомендации проекта. Там её можно будет перенести.");
    // Остальные слова вопроса от окна не зависят: разбор один и тот же.
    expect(догрузка.title).toBe(создание.title);
    expect(догрузка.why).toBe(создание.why);
  });

  it("сноски содержимого и группы в догрузке не меняются, у похожих имён — «догрузке»", () => {
    const общие = (mode: "create" | "into") => buildQuestions({
      family_conflicts: [семья()],
      remainder: остаток({ isolated_groups: [группа()] }),
      mode,
    }).map((q) => q.ifLeft);
    expect(общие("into")).toEqual(общие("create"));
    const пары = (mode: "create" | "into") =>
      buildQuestions({ family_conflicts: [], remainder: остаток({ fuzzy_pairs: [пара()] }), mode })[0]!.ifLeft;
    expect(пары("create")).toBe(
      "Если не отвечать, то останутся два объекта, и при следующем импорте вопрос повторится.");
    expect(пары("into")).toBe(
      "Если не отвечать, то останутся два объекта, и при следующей догрузке вопрос повторится.");
  });

  it("изолированная группа перечисляет три имени и остаток", () => {
    const q = buildQuestions({ family_conflicts: [], remainder: остаток({ isolated_groups: [группа()] }) })[0]!;
    expect(q.title).toBe("У 4 объектов нет связей с остальной схемой. Проведёте связь?");
    expect(q.why).toBe("По файлам невозможно установить, как эти объекты связаны с остальной схемой.");
    expect(q.context).toBe("«Плагин», «Датасорс», «Панель» и ещё 1");
    expect(q.ifLeft).toBe(
      "Если не отвечать, то группа останется без связей и попадёт в рекомендации"
      + " проекта как изолированная группа.");
  });

  it("похожие имена называют оба источника со строчной и место", () => {
    const q = buildQuestions({ family_conflicts: [], remainder: остаток({ fuzzy_pairs: [пара()] }) })[0]!;
    expect(q.title).toBe(
      "«Пользователь Zabbix» и «Пользователь» — похожие имена из разных файлов."
      + " Это один объект или разные?");
    expect(q.context).toBe("из файла zabbix.yaml и из архива plugin.zip, оба на верхнем уровне");
    const догрузка = buildQuestions({
      family_conflicts: [], remainder: остаток({ fuzzy_pairs: [пара({ a_source: "Из проекта" })] }), mode: "into",
    })[0]!;
    expect(догрузка.context).toBe("из проекта и из архива plugin.zip, оба на верхнем уровне");
    // Признак проекта у пары — a_current / b_current (фаза 8б): спорят проект и архив.
    expect(догрузка.title).toBe(
      "«Пользователь Zabbix» и «Пользователь» — похожие имена из разных файлов. Это один объект или разные?");
    const сПроектом = buildQuestions({
      family_conflicts: [], mode: "into",
      remainder: остаток({ fuzzy_pairs: [пара({ b_source: "Из проекта", b_current: true })] }),
    })[0]!;
    expect(сПроектом.title).toBe(
      "«Пользователь Zabbix» и «Пользователь» — похожие имена в проекте и в архиве. Это один объект или разные?");
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

describe("короткая тема для списка «Все вопросы» (фаза 8б)", () => {
  it("спор содержимого: объект и запись по семье", () => {
    const тема = (family: FamilyConflictOut["family"], key: string) =>
      buildQuestions({ family_conflicts: [семья({ family, key })], remainder: остаток() })[0]!.topic;
    expect(тема("doc", "Опрос")).toBe("server, схема логики «Опрос»");
    expect(тема("table", "order_items")).toBe("server, таблица «order_items»");
    expect(тема("channel", "orders.events")).toBe("server, канал «orders.events»");
    expect(тема("config", "MAX_ITEMS")).toBe("server, параметр «MAX_ITEMS»");
    expect(тема("spec", "openapi")).toBe("server, спецификация OpenAPI");
  });

  it("спор поля: объект и поле строчными", () => {
    const тема = (field: FieldDisputeOut["field"]) =>
      buildQuestions({ family_conflicts: [], remainder: остаток({ field_conflicts: [поле({ field })] }) })[0]!.topic;
    const поля: FieldDisputeOut["field"][] = ["description", "technology", "role", "shape", "status", "element"];
    expect(поля.map(тема)).toEqual([
      "server, описание", "server, технология", "server, роль", "server, форма", "server, статус",
      "server, элемент архитектуры",
    ]);
  });

  it("связь, группа и похожие имена", () => {
    const qs = buildQuestions({
      family_conflicts: [],
      remainder: остаток({
        container_edges: [связь(), связь({ container_element: "system", end: "source" })],
        isolated_groups: [группа({ node_paths: ["Плагин"] }), группа({ node_paths: ["А", "Б"] }), группа()],
        fuzzy_pairs: [пара()],
      }),
    });
    expect(qs.map((q) => q.topic)).toEqual([
      "Связь «Датасорс → Zabbix»", "Связь «Датасорс → Zabbix»",
      "1 объект без связей", "2 объекта без связей", "4 объекта без связей",
      "«Пользователь Zabbix» и «Пользователь»",
    ]);
    expect(buildQuestions({
      family_conflicts: [],
      remainder: остаток({ isolated_groups: [группа({ node_paths: ["А", "Б", "В", "Г", "Д"] })] }),
    })[0]!.topic).toBe("5 объектов без связей");
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

  it("подпись ответа — с заглавной, как на варианте: источник, значение, имя склейки", () => {
    const answers: Answers = {
      "field|Zabbix/server|description": { kind: "field", index: 1 },
      "edge|Плагин/Датасорс|Zabbix||target": { kind: "edge", toPath: "Zabbix / server / Поллер" },
      "pair|Пользователь Zabbix|Пользователь": { kind: "merge", name: "Оператор" },
    };
    expect(answerLabel(content!, {}, { "doc|Zabbix/server|Опрос": "all" })).toBe("Добавить все");
    expect(answerLabel(content!, {}, { "doc|Zabbix/server|Опрос": "cand:1" })).toBe("Из архива plugin.zip");
    expect(answerLabel(content!, {}, {})).toBeNull();
    expect(answerLabel(field_!, answers, {})).toBe("Ядро Zabbix");
    expect(answerLabel(edge!, answers, {})).toBe("Поллер");
    expect(answerLabel(pair!, answers, {})).toBe("Оператор");
    // Ответ вариантом по умолчанию — такой же ответ: называется словами варианта (П8).
    expect(answerLabel(group!, { "group|Плагин": { kind: "keep" } }, {})).toBe("Оставить как есть");
    expect(answerLabel(edge!, { [edge!.id]: { kind: "keep" } }, {})).toBe("Оставить на контейнере");
    expect(answerLabel(pair!, { [pair!.id]: { kind: "diff" } }, {})).toBe("Разные объекты");
    expect(answerLabel(group!, {
      "group|Плагин": { kind: "new_edges", edges: [
        { fromPath: "Плагин", toPath: "Zabbix", label: "", tech: "" },
        { fromPath: "Плагин / Датасорс", toPath: "Zabbix", label: "", tech: "" },
      ] },
    }, {})).toBe("Связей: 2");
  });

  it("без ответа — подпись варианта, который действует по умолчанию", () => {
    expect(defaultLabel(content!)).toBe("Добавить все");
    const одна = buildQuestions({
      family_conflicts: [семья({ default: "cand:1", allow_all: false })], remainder: остаток(),
    })[0]!;
    expect(defaultLabel(одна)).toBe("Из архива plugin.zip");
    expect(defaultLabel(field_!)).toBe("Сервер мониторинга");
    expect(defaultLabel(edge!)).toBe("Оставить на контейнере");
    expect(defaultLabel(group!)).toBe("Оставить как есть");
    expect(defaultLabel(pair!)).toBe("Разные объекты");
    // Форма и статус — словами.
    const форма = buildQuestions({ family_conflicts: [], remainder: остаток({
      field_conflicts: [поле({ field: "shape", candidates: [кандидат({ value: "database" }), кандидат({ origin: 1, value: "service" })] })],
    }) })[0]!;
    expect(defaultLabel(форма)).toBe("База данных");
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
