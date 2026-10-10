// Обучающий тур демо-стенда (docs/tasks/demo-tour.md) — корень. App монтирует его
// только гостю в демо-режиме. Здесь сходятся маршрут (хэш), шина событий продукта,
// хранение по id гостя и поиск цели в DOM; логика шагов — в чистой машине
// (tourMachine.ts), отрисовка — в TourLayer.
//
// Тур запускается сам, если для гостя ничего не сохранено (первый вход в песочницу);
// «Пропустить» и «Завершить» сохраняют «пройден», и сам он больше не появится —
// заново его запускает пилюля «Обучение» в шапке (TourHelpButton). Клик по затемнению
// ставит тур на паузу: пилюля становится «Продолжить обучение».
import {
  useCallback, useEffect, useLayoutEffect, useMemo, useReducer, useRef, useState, useSyncExternalStore,
} from "react";
import { fetchMe, getCanCreateProject, getMe, subscribeMe } from "../../api/auth";
import { nodesApi } from "../../api/nodes";
import { projectsApi } from "../../api/projects";
import { onTourEvent, requestTourLevel, type TourBusEvent } from "./tourBus";
import {
  availability, canGoBack, expandTarget, onScreen, reduceTour, screenHash, startState, stepTexts, stepTotal,
  treeExpandTarget,
  type TourAction, type TourEnv, type TourSignal, type TourState,
} from "./tourMachine";
import { parseTourRoute, routeProject, type TourRoute } from "./tourRoute";
import { STEPS, YAR_PROJECT, type StepId } from "./tourSteps";
import {
  dropStaleTours, loadTour, markExitToPill, onTourRestart, onTourResume, saveTour, setTourPaused, takeExitToPill,
} from "./tourStore";
import { hiddenTarget, resolveTarget, revealTarget, topDialog } from "./tourTargets";
import TourLayer from "./TourLayer";
import { TourMotion, motionTarget, prefersReducedMotion, type MotionFrame } from "./tourMotion";
import { HIDDEN_VIEW, type TourView } from "./tourView";

/** Сколько ждать цель после входа в шаг или смены экрана, прежде чем считать, что
 *  пользователь ушёл в сторону (холст раскладывается не мгновенно). */
const GRACE_MS = 1500;
/** Скрытую цель (за краем холста, ниже сгиба) подводим в вид не чаще раза в это
 *  время и не больше REVEAL_TRIES раз на шаг: раскладка после раскрытия оседает не сразу. */
const REVEAL_EVERY_MS = 1200;
const REVEAL_TRIES = 3;
/** Цель шага (или зона пары) пропала на кадр-другой — узел перерисовался, холст ещё
 *  монтируется: столько держим прежний кадр шага, прежде чем ждать её как новую или
 *  убирать зону. Вырез и карточка не дёргаются. */
const HOLD_MS = 120;

export default function DemoTour() {
  const me = useSyncExternalStore(subscribeMe, getMe);
  if (!me?.is_guest) return null;
  return <TourRuntime key={me.id} userId={me.id} />;
}

// Шаг, объекты которого пропали, перешагивается в направлении хода — и при чтении,
// и перед каждым действием (производное, а не эффект с setState).
function normalize(state: TourState, env: TourEnv): TourState {
  return state.status === "running" && availability(state.step, state, env) === "no"
    ? reduceTour(state, { type: "unavailable" }, env)
    : state;
}

type Msg = { action: TourAction; env: TourEnv } | { reset: TourState };

function reducer(state: TourState, msg: Msg): TourState {
  if ("reset" in msg) return msg.reset;
  return reduceTour(normalize(state, msg.env), msg.action, msg.env);
}

function initTour(userId: string): TourState {
  dropStaleTours(userId);
  return loadTour(userId) ?? startState("full");
}

/** Ключ вида для сравнения кадров: перерисовываем, только когда что-то сдвинулось. */
function viewKey(v: TourView): string {
  const r = (n: number) => Math.round(n);
  const rect = (x: { x: number; y: number; w: number; h: number }) => `${r(x.x)},${r(x.y)},${r(x.w)},${r(x.h)}`;
  const pt = (p: { x: number; y: number }) => `${r(p.x)},${r(p.y)}`;
  const demo = v.demo ? [pt(v.demo.grab), pt(v.demo.drop), pt(v.demo.fixed), v.demo.dropSide, v.demo.fixedSide,
    v.demo.headAtFixed ? 1 : 0, v.demo.zoom.toFixed(3)].join(",") : "";
  return [v.phase, v.holes.map((h) => h.shape + rect(h)).join(";"), v.anchor ? rect(v.anchor) : "",
    v.avoid.map(rect).join(";"), v.soft.map(rect).join(";"), demo].join("|");
}

/** Ключ кадра анимации: пока вырез едет или затемнение проявляется, он меняется
 *  каждый кадр; в покое — стоит, и лишних перерисовок нет. */
function motionKey(m: MotionFrame): string {
  const r = (n: number) => Math.round(n * 2) / 2;
  return [m.opacity.toFixed(2), m.settled ? "1" : "0",
    m.holes.map((h) => `${h.shape}${r(h.x)},${r(h.y)},${r(h.w)},${r(h.h)},${r(h.r)},${h.alpha.toFixed(2)}`).join(";")].join("|");
}

/** Кадр слоя: шаг, для которого он посчитан, цель кадра и что рисовать сейчас. */
interface LayerFrame { step: StepId | null; v: TourView; m: MotionFrame | null }
const NO_FRAME: LayerFrame = { step: null, v: HIDDEN_VIEW, m: null };

function TourRuntime({ userId }: { userId: string }) {
  const [raw, send] = useReducer(reducer, userId, initTour);
  const [route, setRoute] = useState<TourRoute>(() => parseTourRoute(window.location.hash));
  const [yarProjectId, setYarProjectId] = useState<string | null | undefined>(undefined);
  const [yarObjects, setYarObjects] = useState<ReadonlyMap<string, string> | undefined>(undefined);
  // Кадр слоя — с шагом, для которого он посчитан: карточка нового шага не рисуется
  // поверх выреза прежнего, пока кадровый цикл не посчитал новый, а до тех пор на
  // экране остаётся прежний кадр целиком (без пустого кадра между шагами).
  const [view, setView] = useState<LayerFrame>(NO_FRAME);

  const env = useMemo<TourEnv>(() => ({ yarProjectId, yarObjects }), [yarProjectId, yarObjects]);
  const state = useMemo(() => normalize(raw, env), [raw, env]);
  const running = state.status === "running";

  // Последние значения для слушателей и кадрового цикла (ставятся эффектами).
  const stateRef = useRef(state);
  const envRef = useRef(env);
  const routeRef = useRef(route);
  const enteredAtRef = useRef(0);
  const routeAtRef = useRef(0);
  // Последний слой редактора, о котором сообщила шина (проект:слой).
  const lastLevelRef = useRef<string | null>(null);
  // Слой, открытый в редакторе сейчас (undefined — не в редакторе), и слой, на который
  // «Продолжить обучение» вернёт, когда редактор откроется (undefined — никуда).
  const levelRef = useRef<string | null | undefined>(undefined);
  const pendingLevelRef = useRef<string | null | undefined>(undefined);
  // Layout-эффекты: кадровый цикл (rAF) обязан увидеть новый шаг уже в ближайшем кадре,
  // а пассивные эффекты могут прийти после него.
  useLayoutEffect(() => { stateRef.current = state; }, [state]);
  useLayoutEffect(() => { envRef.current = env; }, [env]);

  const dispatch = useCallback((action: TourAction) => send({ action, env: envRef.current }), []);

  useEffect(() => { saveTour(userId, state); }, [userId, state]);

  // ── Маршрут ──
  useEffect(() => {
    const onHash = () => {
      const next = parseTourRoute(window.location.hash);
      routeRef.current = next;
      routeAtRef.current = performance.now();
      if (next.name !== "map") {
        lastLevelRef.current = null;
        levelRef.current = undefined;
      }
      setRoute(next);
      send({ action: { type: "signal", signal: { kind: "route", route: next } }, env: envRef.current });
    };
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);

  // ── Шина событий продукта ──
  // Слой редактора приходит после каждой загрузки, в том числе фоновой: сигналом
  // считается только смена слоя (вход на слой, возврат наверх).
  useEffect(() => onTourEvent((e: TourBusEvent) => {
    const pid = routeProject(routeRef.current);
    let signal: TourSignal;
    switch (e.type) {
      case "level": {
        if (!pid) return;
        levelRef.current = e.levelId;
        // Редактор открылся после «Продолжить обучение» — на слой, где взяли паузу.
        const want = pendingLevelRef.current;
        if (want !== undefined) {
          pendingLevelRef.current = undefined;
          if (want !== e.levelId) requestTourLevel(want);
        }
        const key = `${pid}:${e.levelId ?? ""}`;
        if (lastLevelRef.current === key) return;
        lastLevelRef.current = key;
        signal = { kind: "level", projectId: pid, levelId: e.levelId };
        break;
      }
      case "node-created":
        signal = { kind: "node-created", projectId: pid, id: e.id, name: e.name, shape: e.shape, parentId: e.parentId };
        break;
      case "edge-created":
        signal = { kind: "edge-created", projectId: pid, id: e.id, sourceId: e.sourceId, targetId: e.targetId };
        break;
      case "edge-reconnected":
        signal = { kind: "edge-reconnected", projectId: pid, fromId: e.fromId, toId: e.toId };
        break;
      case "node-expanded":
        signal = { kind: "node-expanded", projectId: pid, id: e.id };
        break;
      case "node-drag-end":
        signal = { kind: "node-drag-end", projectId: pid, ids: e.ids };
        break;
    }
    send({ action: { type: "signal", signal }, env: envRef.current });
  }), []);

  // ── «Обучение»: пройти заново. Свой проект уже есть («Новый проект» погашена) — короткий
  // проход по «Ярмарке». Признак берём свежим с сервера: кэш «кто я» мог устареть.
  useEffect(() => onTourRestart(() => {
    void fetchMe().catch(() => undefined).then(() => {
      lastLevelRef.current = null;
      setYarProjectId(undefined); // «Ярмарку» ищем заново: её могли переименовать
      send({ reset: startState(getCanCreateProject() ? "full" : "short") });
    });
  }), []);

  // ── Пауза (docs/tasks/demo-tour-pause.md): клик по затемнению свернул тур в пилюлю ──
  // «Продолжить обучение»: шаг за паузу не продвинулся — назад, где её взяли (экран и
  // слой схемы); продвинулся — экран нового шага откроет «Вход в шаг», как после «Далее».
  useEffect(() => onTourResume(() => {
    const st = stateRef.current;
    if (st.status !== "paused") return;
    takeExitToPill(); // карточки на паузе нет — признак сворачивания не должен зависнуть
    const at = st.pause;
    send({ action: { type: "resume" }, env: envRef.current });
    if (!at || at.step !== st.step) return;
    if (at.level !== undefined) {
      // слой знает только открытый редактор: здесь он открыт — просим сразу, иначе —
      // когда откроется (событие «level»)
      if (levelRef.current === undefined || window.location.hash !== at.hash) pendingLevelRef.current = at.level;
      else if (levelRef.current !== at.level) requestTourLevel(at.level);
    }
    if (window.location.hash !== at.hash) window.location.hash = at.hash;
  }), []);
  // Пилюля в шапке зовёт «Продолжить обучение», пока тур на паузе. Layout-эффект:
  // пилюля обновляется в том же коммите, и карточка сворачивается уже в «Продолжить».
  const paused = state.status === "paused";
  useLayoutEffect(() => { setTourPaused(paused); }, [paused]);
  useEffect(() => () => setTourPaused(false), []);

  // ── «Ярмарка»: проект по имени, его объекты по именам ──
  useEffect(() => {
    if (!running || yarProjectId !== undefined) return;
    let alive = true;
    projectsApi.list(false)
      .then((list) => {
        if (!alive) return;
        const found = Array.isArray(list) ? list.find((p) => p.name === YAR_PROJECT) : undefined;
        setYarProjectId(found ? found.id : null);
      })
      .catch(() => { /* сеть — повторим на следующем экране */ });
    return () => { alive = false; };
  }, [running, yarProjectId, route]);

  // Объекты «Ярмарки» читаются, когда пользователь в её проекте (скоуп X-Project-Id
  // выставлен роутером App), и освежаются на каждом шаге: гость мог что-то удалить.
  const inYar = !!yarProjectId && routeProject(route) === yarProjectId;
  useEffect(() => {
    if (!running || !inYar) return;
    let alive = true;
    nodesApi.getAll()
      .then((nodes) => {
        if (!alive || !Array.isArray(nodes)) return;
        const byName = new Map<string, string>();
        for (const n of nodes) if (!byName.has(n.name)) byName.set(n.name, n.id);
        setYarObjects(byName);
      })
      .catch(() => { /* оставим прежний список */ });
    return () => { alive = false; };
  }, [running, inYar, state.step]);

  // ── Вход в шаг: отметка времени и переход на экран шага ──
  // После перезагрузки страницы на сохранённом шаге никуда не ведём: пользователь мог
  // уйти в сторону сам, шаг подождёт его на своём экране. Продолжение после паузы —
  // тоже вход в шаг: режим, прокрутка и подводка к цели делаются заново, а пока тур на
  // паузе, он никуда не уводит.
  const navForRef = useRef<StepId | null>(raw.step);
  // Разовые действия входа в шаг: режим оболочки выставлен, цель прокручена, уже
  // раскрытый узел засчитан; treeClosed — ветка дерева была свёрнутой на этом шаге.
  const doneForRef = useRef({ mode: false, scroll: false, expanded: false, treeClosed: false, reveals: 0, revealAt: 0 });
  useLayoutEffect(() => {
    enteredAtRef.current = performance.now();
    doneForRef.current = { mode: false, scroll: false, expanded: false, treeClosed: false, reveals: 0, revealAt: 0 };
  }, [state.step, running]);
  useEffect(() => {
    if (!running || navForRef.current === state.step) return;
    const step = STEPS[state.step];
    if (onScreen(step.screen, routeRef.current, state, env)) {
      navForRef.current = state.step;
      return;
    }
    const hash = screenHash(step.screen, state, env);
    if (hash === null) return; // данных ещё нет — повторим, когда появятся
    navForRef.current = state.step;
    window.location.hash = hash;
  }, [running, state, env]);

  // Шаг «Перевесьте связь»: плашка подписи может лечь на ручку конца — пропускаем
  // нажатия сквозь плашки, пока шаг на экране (tour.css, .tour-pass-labels).
  const passLabels = running && state.step === "rehang";
  useEffect(() => {
    if (!passLabels) return;
    document.body.classList.add("tour-pass-labels");
    return () => document.body.classList.remove("tour-pass-labels");
  }, [passLabels]);

  // ── Кадровый цикл: цель в DOM, вырезы, окно поверх, сигналы DOM, кадр анимации ──
  useEffect(() => {
    if (!running) return;
    let raf = 0;
    let lastKey = "";
    let lastHost: HTMLElement | null = null;
    // Когда цель видели последний раз: пропавшую только что цель (нажали «Войти» —
    // слой перезагружается, кнопки уже нет) ждём так же, как новую.
    let foundAt = 0;
    // Последний кадр с целью целиком и когда он был — держим его HOLD_MS, если цель
    // шага (или зона пары) на миг пропала.
    let lastSpot: { step: StepId; view: TourView; at: number } | null = null;
    // Куда слой рисовал последний раз: окно поверх — затемнение гаснет там же.
    let drawHost: HTMLElement | null = null;
    // Плавность: вырезы и затемнение идут к цели кадра (tourMotion.ts).
    const motion = new TourMotion(prefersReducedMotion());
    const frame = () => {
      raf = requestAnimationFrame(frame);
      const now = performance.now();
      const st = stateRef.current;
      const en = envRef.current;
      const rt = routeRef.current;
      const step = STEPS[st.step];
      const dialog = topDialog();
      const screenOk = onScreen(step.screen, rt, st, en);
      let next: TourView;
      if (step.kind === "start" || step.kind === "end") {
        next = { ...HIDDEN_VIEW, phase: "center", host: dialog ?? document.body };
      } else {
        const tctx = { yarProjectId: en.yarProjectId, yarObjects: en.yarObjects, vars: st.vars };
        const res = screenOk && step.target ? resolveTarget(step.target, tctx) : null;
        // Цель есть, но не видна (за краем холста, ниже сгиба страницы) — подводим к ней.
        const done = doneForRef.current;
        if (!res && screenOk && step.target && !dialog && done.reveals < REVEAL_TRIES && now - done.revealAt > REVEAL_EVERY_MS) {
          const hidden = hiddenTarget(step.target, tctx);
          if (hidden) {
            done.reveals += 1;
            done.revealAt = now;
            revealTarget(hidden);
          }
        }
        const held = lastSpot?.step === st.step && now - lastSpot.at < HOLD_MS ? lastSpot.view : null;
        if (res && (!dialog || res.elements.every((el) => dialog.contains(el)))) {
          const found: TourView = {
            phase: "spot", host: dialog ?? document.body, holes: res.holes, anchor: res.anchor, avoid: res.avoid,
            soft: res.soft ?? [], ...(res.demo ? { demo: res.demo } : {}),
          };
          // Пара нашлась без зоны (холст ещё монтируется) — держим прежний кадр с зоной.
          next = held && found.holes.length < held.holes.length ? held : found;
          foundAt = now;
          // Секции страницы объекта — к середине экрана, один раз на вход в шаг.
          if (step.target?.kind === "tour" && step.target.scroll && !doneForRef.current.scroll) {
            doneForRef.current.scroll = true;
            const el = res.elements[0];
            const tall = el.getBoundingClientRect().height > window.innerHeight * 0.6;
            el.scrollIntoView({ block: tall ? "start" : "center", behavior: "smooth" });
          }
        } else if (held) {
          // Только что открылось окно, а шаг ещё прежний (окно и есть следующий шаг) —
          // тоже держим: затемнение не проседает на кадр.
          next = held;
        } else if (dialog) {
          // Открыто окно, а цель не в нём: окно работает, тур не мешает.
          next = HIDDEN_VIEW;
        } else {
          const since = Math.max(enteredAtRef.current, routeAtRef.current, foundAt);
          next = { ...HIDDEN_VIEW, phase: now - since < GRACE_MS ? "pending" : "docked", host: document.body };
        }
        if (next.phase === "spot" && next !== held) lastSpot = { step: st.step, view: next, at: now };
      }
      // Режим оболочки («Объекты»/«Процессы») — один раз на вход в шаг.
      if (step.mode && screenOk && !doneForRef.current.mode) {
        const tab = document.querySelector<HTMLElement>(`[data-tour="mode-${step.mode}"]`);
        if (tab) {
          doneForRef.current.mode = true;
          tab.click();
        }
      }
      // Повторный проход: узел раскрыт ещё с прошлого раза (раскрытие хранится в виде) —
      // идя вперёд, шаг засчитываем сразу. «Назад» на такой шаг оставляет его ждать.
      if (screenOk && st.dir === 1 && !doneForRef.current.expanded) {
        const id = expandTarget(st, en);
        if (id && document.querySelector(`.react-flow__node-frame[data-id="${id}"]`)) {
          doneForRef.current.expanded = true;
          send({ action: { type: "signal", signal: { kind: "node-expanded", projectId: routeProject(rt), id } }, env: en });
        }
      }
      // Дерево: ветка раскрыта (шеврон в DOM — aria-expanded). Идя вперёд, уже раскрытая
      // засчитывается сразу; после «Назад» — когда её свернули и раскрыли снова.
      const treeId = screenOk ? treeExpandTarget(st, en) : null;
      const chev = treeId ? document.querySelector(`[data-tour="tree-chev:${treeId}"]`) : null;
      if (chev) {
        if (chev.getAttribute("aria-expanded") !== "true") doneForRef.current.treeClosed = true;
        else if (st.dir === 1 || doneForRef.current.treeClosed) {
          send({ action: { type: "signal", signal: { kind: "dom", key: "tree-expanded" } }, env: en });
        }
      }
      // «Новый проект»: окно открылось — шаг сделан; кнопка погашена — проект уже есть.
      if (st.step === "new-project") {
        if (document.querySelector('[data-tour="create-project"]')) {
          send({ action: { type: "signal", signal: { kind: "dom", key: "create-project" } }, env: en });
        } else if (document.querySelector('[data-tour="new-project"][aria-disabled="true"]')) {
          send({ action: { type: "blocked" }, env: en });
        }
      }
      // Кадр анимации. Окно поверх (цели в нём нет) — затемнение гаснет там, где было.
      const m = motion.frame(now, motionTarget(st.step, next), window.innerWidth, window.innerHeight);
      if (next.host) drawHost = next.host;
      const v = next.host ? next : { ...next, host: drawHost };
      const key = `${st.step}|${viewKey(v)}|${motionKey(m)}`;
      if (key !== lastKey || v.host !== lastHost) {
        lastKey = key;
        lastHost = v.host;
        setView({ step: st.step, v, m });
      }
    };
    raf = requestAnimationFrame(frame);
    return () => {
      cancelAnimationFrame(raf);
      // Тур закрыт — кадр прохода снят: новый проход («Обучение») начинает с пустого
      // слоя, а не с карточки и затемнения шага, на котором вышли.
      setView(NO_FRAME);
    };
  }, [running]);

  if (!running || view.step === null) return null;
  // Слой рисует кадр того шага, для которого он посчитан (см. view выше).
  const step = STEPS[view.step];
  return (
    <TourLayer
      view={view.v}
      motion={view.m ?? undefined}
      stepKey={view.step}
      step={step}
      texts={stepTexts(step, state.vars)}
      count={step.n !== undefined ? `Шаг ${step.n} из ${stepTotal(state.variant)}` : null}
      canBack={canGoBack(view.step)}
      onNext={() => dispatch({ type: "next" })}
      onBack={() => dispatch({ type: "back" })}
      onSkip={() => dispatch({ type: "skip" })}
      onFinish={() => dispatch({ type: "finish" })}
      onShade={() => {
        // Клик по затемнению: на финале — «Завершить», иначе — пауза там, где человек
        // сейчас (экран и слой схемы): «Продолжить обучение» вернёт сюда.
        if (step.kind === "end") {
          dispatch({ type: "finish" });
          return;
        }
        markExitToPill();
        dispatch({ type: "pause", at: { step: stateRef.current.step, hash: window.location.hash, level: levelRef.current } });
      }}
    />
  );
}
