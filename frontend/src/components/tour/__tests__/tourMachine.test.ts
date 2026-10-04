// Машина состояний обучающего тура (docs/tasks/demo-tour.md): переходы по кнопкам и
// сигналам продукта, пропуск шагов с удалёнными объектами «Ярмарки», захват имён
// созданных объектов и их подстановка, короткий проход при уже созданном проекте.
import { describe, it, expect } from "vitest";
import {
  availability, canGoBack, onScreen, parseTourState, reduceTour, screenHash, startState,
  stepTexts, stepTotal,
  type TourAction, type TourEnv, type TourSignal, type TourState,
} from "../tourMachine";
import { parseTourRoute } from "../tourRoute";
import {
  STEPS, YAR_BROKER, YAR_ORDER_API, YAR_ORDERS, YAR_ORDERS_DB, YAR_SELLER, YAR_SYSTEM,
  type StepId,
} from "../tourSteps";

const YAR = "aaaa-0001";
const OWN = "bbbb-0002";
const OBJECTS = new Map<string, string>([
  [YAR_SELLER, "c0de-01"],
  [YAR_SYSTEM, "c0de-02"],
  [YAR_ORDERS, "c0de-03"],
  [YAR_ORDER_API, "c0de-04"],
  [YAR_ORDERS_DB, "c0de-05"],
  [YAR_BROKER, "c0de-06"],
]);
const ENV: TourEnv = { yarProjectId: YAR, yarObjects: OBJECTS };

const at = (step: StepId, patch: Partial<TourState> = {}): TourState =>
  ({ ...startState("full"), step, ...patch });
const run = (s: TourState, actions: TourAction[], env: TourEnv = ENV): TourState =>
  actions.reduce((acc, a) => reduceTour(acc, a, env), s);
const sig = (signal: TourSignal): TourAction => ({ type: "signal", signal });
const route = (hash: string): TourAction => sig({ kind: "route", route: parseTourRoute(hash) });
const NEXT: TourAction = { type: "next" };
const BACK: TourAction = { type: "back" };

// Свой проект с системой и вторым объектом — состояние к шагу «Проведите связь».
const OWN_VARS = {
  ownProjectId: OWN, systemId: "s1", systemName: "Платёжный шлюз", peerId: "p1", peerName: "Банк",
};

describe("тур — проход по «Ярмарке»", () => {
  it("приветствие → карточка; «Далее» на шаге с действием не работает", () => {
    const s = run(startState("full"), [NEXT]);
    expect(s.step).toBe("open-yar");
    expect(run(s, [NEXT]).step).toBe("open-yar");
  });

  it("открыл «Ярмарку» — главная; чужой проект шаг не засчитывает", () => {
    expect(run(at("open-yar"), [route(`#/p/${OWN}`)]).step).toBe("open-yar");
    expect(run(at("open-yar"), [route(`#/p/${YAR}`)]).step).toBe("yar-home");
  });

  it("цепочка редактора: маршрут, драг, раскрытия по id объектов", () => {
    let s = run(at("yar-home"), [NEXT]);
    expect(s.step).toBe("open-editor");
    s = run(s, [route(`#/p/${YAR}/map`)]);
    expect(s.step).toBe("drag");
    s = run(s, [sig({ kind: "node-drag-end", projectId: YAR, ids: ["c0de-01"] })]);
    expect(s.step).toBe("expand-system");
    // раскрыт не тот узел — ждём дальше
    s = run(s, [sig({ kind: "node-expanded", projectId: YAR, id: "c0de-03" })]);
    expect(s.step).toBe("expand-system");
    s = run(s, [sig({ kind: "node-expanded", projectId: YAR, id: "c0de-02" })]);
    expect(s.step).toBe("expand-service");
    s = run(s, [sig({ kind: "node-expanded", projectId: YAR, id: "c0de-03" })]);
    expect(s.step).toBe("service-expanded");
  });

  it("вход на слой системы засчитывается как её раскрытие", () => {
    const s = run(at("expand-system"), [sig({ kind: "level", projectId: YAR, levelId: "c0de-02" })]);
    expect(s.step).toBe("expand-service");
  });

  it("логотип ведёт к списку — дальше «Новый проект» и окно создания", () => {
    let s = run(at("leave-yar"), [route("#/projects")]);
    expect(s.step).toBe("new-project");
    s = run(s, [sig({ kind: "dom", key: "create-project" })]);
    expect(s.step).toBe("create-blank");
    s = run(s, [route(`#/p/${OWN}`)]);
    expect(s.step).toBe("create-system");
    expect(s.vars.ownProjectId).toBe(OWN);
  });

  it("на шаге создания проекта переход в «Ярмарку» — не свой проект", () => {
    expect(run(at("create-blank"), [route(`#/p/${YAR}`)]).step).toBe("create-blank");
  });

  it("«Пропустить» на любом шаге и «Завершить» на финале завершают тур", () => {
    expect(run(at("drag"), [{ type: "skip" }]).status).toBe("done");
    expect(run(at("welcome"), [{ type: "skip" }]).status).toBe("done");
    expect(run(at("final"), [{ type: "finish" }]).status).toBe("done");
    expect(run(at("final"), [NEXT]).status).toBe("done");
  });

  it("завершённый тур сигналы и кнопки не трогают", () => {
    const done = { ...at("drag"), status: "done" as const };
    expect(run(done, [NEXT, BACK, sig({ kind: "node-drag-end", projectId: YAR, ids: ["x"] })])).toBe(done);
  });

  it("«Назад» — с шага 2; на первом и на финалах кнопки нет", () => {
    expect(run(at("yar-home"), [BACK]).step).toBe("open-yar");
    expect(canGoBack("open-yar")).toBe(false);
    expect(canGoBack("yar-home")).toBe(true);
    expect(canGoBack("final")).toBe(false);
    expect(canGoBack("welcome")).toBe(false);
  });
});

describe("тур — пропуск ненайденных объектов", () => {
  it("гость удалил «Продавца»: после редактора сразу раскрытие системы", () => {
    const objects = new Map(OBJECTS);
    objects.delete(YAR_SELLER);
    const env = { ...ENV, yarObjects: objects };
    const s = run(at("open-editor"), [route(`#/p/${YAR}/map`)], env);
    expect(s.step).toBe("expand-system");
    // и «Назад» тоже перешагивает пропавший шаг
    expect(run(s, [BACK], env).step).toBe("open-editor");
  });

  it("нет «Сервиса заказов»: страницы БД и брокера остаются", () => {
    const objects = new Map(OBJECTS);
    objects.delete(YAR_ORDERS);
    const env = { ...ENV, yarObjects: objects };
    const s = run(at("expand-system"), [sig({ kind: "node-expanded", projectId: YAR, id: "c0de-02" })], env);
    // 6, 7 и 8 завязаны на «Сервис заказов» — следующий шаг документация Order API
    expect(s.step).toBe("service-docs");
  });

  it("объекты выяснились после входа в шаг — «unavailable» идёт в направлении хода", () => {
    const loading: TourEnv = { yarProjectId: YAR, yarObjects: undefined };
    const s = run(at("open-editor"), [route(`#/p/${YAR}/map`)], loading);
    expect(s.step).toBe("drag");
    expect(availability("drag", s, loading)).toBe("unknown");
    const loaded = { ...ENV, yarObjects: new Map([[YAR_SYSTEM, "c0de-02"]]) };
    expect(run(s, [{ type: "unavailable" }], loaded).step).toBe("expand-system");
    // пока объект на месте, сигнал ничего не меняет
    expect(run(s, [{ type: "unavailable" }], ENV).step).toBe("drag");
  });

  it("«Ярмарки» нет вовсе: от приветствия сразу к своему проекту", () => {
    const env: TourEnv = { yarProjectId: null, yarObjects: undefined };
    expect(run(startState("full"), [NEXT], env).step).toBe("new-project");
  });
});

describe("тур — свой проект", () => {
  it("система — новый «Сервис» в корне своего проекта; второй объект — любой в корне", () => {
    let s = at("create-system", { vars: { ownProjectId: OWN } });
    // база в корне — не система
    s = run(s, [sig({ kind: "node-created", projectId: OWN, id: "d1", name: "БД", shape: "database", parentId: null })]);
    expect(s.step).toBe("create-system");
    // сервис в чужом проекте — не система
    s = run(s, [sig({ kind: "node-created", projectId: YAR, id: "x", name: "X", shape: "service", parentId: null })]);
    expect(s.step).toBe("create-system");
    s = run(s, [sig({ kind: "node-created", projectId: OWN, id: "s1", name: "Платёжный шлюз", shape: "service", parentId: null })]);
    expect(s).toMatchObject({ step: "add-peer", vars: { systemId: "s1", systemName: "Платёжный шлюз" } });
    s = run(s, [sig({ kind: "node-created", projectId: OWN, id: "p1", name: "Банк", shape: "person", parentId: null })]);
    expect(s).toMatchObject({ step: "connect", vars: { peerId: "p1", peerName: "Банк" } });
  });

  it("связь между системой и вторым объектом — в любую сторону", () => {
    const s = at("connect", { vars: OWN_VARS });
    const edge = (a: string, b: string) =>
      sig({ kind: "edge-created", projectId: OWN, id: "e1", sourceId: a, targetId: b });
    expect(run(s, [edge("p1", "x")]).step).toBe("connect");
    expect(run(s, [edge("p1", "s1")]).step).toBe("enter-system");
    expect(run(s, [edge("s1", "p1")]).step).toBe("enter-system");
  });

  it("вход на слой системы, сервис внутри, перевес связи, возврат и лупа", () => {
    let s = at("enter-system", { vars: OWN_VARS });
    s = run(s, [sig({ kind: "level", projectId: OWN, levelId: "p1" })]);
    expect(s.step).toBe("enter-system");
    s = run(s, [sig({ kind: "level", projectId: OWN, levelId: "s1" })]);
    expect(s.step).toBe("add-child");
    // сервис в корне — не ребёнок системы
    s = run(s, [sig({ kind: "node-created", projectId: OWN, id: "c0", name: "Лишний", shape: "service", parentId: null })]);
    expect(s.step).toBe("add-child");
    s = run(s, [sig({ kind: "node-created", projectId: OWN, id: "c1", name: "Касса", shape: "service", parentId: "s1" })]);
    expect(s).toMatchObject({ step: "rehang", vars: { childId: "c1", childName: "Касса" } });
    s = run(s, [sig({ kind: "edge-reconnected", projectId: OWN, fromId: "other", toId: "c1" })]);
    expect(s.step).toBe("rehang");
    s = run(s, [sig({ kind: "edge-reconnected", projectId: OWN, fromId: "s1", toId: "c1" })]);
    expect(s.step).toBe("go-up");
    s = run(s, [sig({ kind: "level", projectId: OWN, levelId: "s1" })]);
    expect(s.step).toBe("go-up");
    s = run(s, [sig({ kind: "level", projectId: OWN, levelId: null })]);
    expect(s.step).toBe("context-edge");
    s = run(s, [NEXT]);
    expect(s.step).toBe("expand-own");
    s = run(s, [sig({ kind: "node-expanded", projectId: OWN, id: "s1" })]);
    expect(s.step).toBe("final");
  });

  it("имена созданных объектов подставляются в именительном падеже", () => {
    const vars = { ...OWN_VARS, childName: "Касса" };
    expect(stepTexts(STEPS.connect, vars).action)
      .toBe("Протяните стрелку от точки на объекте «Банк» к точке на объекте «Платёжный шлюз».");
    expect(stepTexts(STEPS["enter-system"], vars).action).toBe("Нажмите «Войти» на системе «Платёжный шлюз».");
    expect(stepTexts(STEPS["add-child"], vars).action).toBe("Перетащите «Сервис» в рамку «Платёжный шлюз».");
    expect(stepTexts(STEPS.rehang, vars).body.startsWith("Система «Платёжный шлюз» стала контейнером.")).toBe(true);
    expect(stepTexts(STEPS.rehang, vars).action).toBe("Потяните конец стрелки с рамки и отпустите на объекте «Касса».");
    expect(stepTexts(STEPS["context-edge"], vars).body)
      .toBe("Для слоя контекста это правда: «Банк» работает с системой «Платёжный шлюз» целиком.");
  });

  it("без захваченных имён — имена прототипа", () => {
    expect(stepTexts(STEPS["enter-system"], {}).action).toBe("Нажмите «Войти» на системе «Моя система».");
  });

  it("«Назад» со своего проекта перешагивает уже невыполнимое создание проекта", () => {
    const s = at("create-system", { vars: { ownProjectId: OWN } });
    expect(run(s, [BACK]).step).toBe("leave-yar");
  });
});

describe("тур — повторный запуск при своём проекте", () => {
  it("короткий проход: «Ярмарка» до логотипа и короткий финал", () => {
    expect(stepTotal("full")).toBe(24);
    expect(stepTotal("short")).toBe(13);
    const s = run({ ...startState("short"), step: "leave-yar" }, [route("#/projects")]);
    expect(s.step).toBe("final-short");
    expect(stepTexts(STEPS[s.step], s.vars).body).toBe("Свой проект у вас уже есть. Продолжайте в нём.");
  });

  it("«Новый проект» погашена посреди полного прохода — короткий финал", () => {
    const s = run(at("new-project"), [{ type: "blocked" }]);
    expect(s).toMatchObject({ variant: "short", step: "final-short" });
    // на других шагах сигнал не действует
    expect(run(at("drag"), [{ type: "blocked" }]).step).toBe("drag");
  });
});

describe("тур — экраны шагов", () => {
  const own = at("create-system", { vars: { ownProjectId: OWN } });
  it("экран шага сверяется с маршрутом", () => {
    expect(onScreen(STEPS.tree.screen, parseTourRoute(`#/p/${YAR}/nodes/c0de-03`), own, ENV)).toBe(true);
    expect(onScreen(STEPS.tree.screen, parseTourRoute(`#/p/${YAR}/nodes/c0de-04`), own, ENV)).toBe(false);
    expect(onScreen(STEPS["create-system"].screen, parseTourRoute(`#/p/${OWN}/map`), own, ENV)).toBe(true);
    expect(onScreen(STEPS["create-system"].screen, parseTourRoute(`#/p/${OWN}`), own, ENV)).toBe(false);
    expect(onScreen(STEPS["leave-yar"].screen, parseTourRoute(`#/p/${YAR}/map`), own, ENV)).toBe(true);
    expect(onScreen(STEPS.processes.screen, parseTourRoute(`#/p/${YAR}/map`), own, ENV)).toBe(false);
  });

  it("куда вести при входе в шаг", () => {
    expect(screenHash(STEPS["service-docs"].screen, own, ENV)).toBe(`/p/${YAR}/nodes/c0de-04`);
    expect(screenHash(STEPS["open-yar"].screen, own, ENV)).toBe("/projects");
    expect(screenHash(STEPS["create-system"].screen, own, ENV)).toBe(`/p/${OWN}/map`);
    expect(screenHash(STEPS["create-blank"].screen, own, ENV)).toBeNull();
  });
});

describe("тур — маршрут и хранение", () => {
  it("хэш разбирается как у роутера App", () => {
    expect(parseTourRoute("#/projects")).toEqual({ name: "projects" });
    expect(parseTourRoute("")).toEqual({ name: "projects" });
    expect(parseTourRoute(`#/p/${YAR}`)).toEqual({ name: "project-home", projectId: YAR });
    expect(parseTourRoute(`#/p/${YAR}/nodes/abc-1`)).toEqual({ name: "node", projectId: YAR, nodeId: "abc-1" });
    expect(parseTourRoute(`#/p/${YAR}/map`)).toEqual({ name: "map", projectId: YAR });
    expect(parseTourRoute(`#/p/${YAR}/map/abc-1?locate=x`)).toEqual({ name: "map", projectId: YAR });
    expect(parseTourRoute("#/admin/users")).toEqual({ name: "other" });
  });

  it("сохранённое состояние читается обратно, мусор — нет", () => {
    const s = at("connect", { vars: OWN_VARS, dir: -1 });
    expect(parseTourState(JSON.stringify(s))).toEqual(s);
    expect(parseTourState(null)).toBeNull();
    expect(parseTourState("{")).toBeNull();
    expect(parseTourState(JSON.stringify({ ...s, step: "nope" }))).toBeNull();
    // шаг своего проекта в коротком проходе не бывает
    expect(parseTourState(JSON.stringify({ ...s, variant: "short" }))).toBeNull();
    expect(parseTourState(JSON.stringify({ ...s, vars: { systemId: 5, peerName: "Банк" } })))
      .toMatchObject({ vars: { peerName: "Банк" } });
  });
});
