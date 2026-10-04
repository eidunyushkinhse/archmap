// Обучающий тур демо-стенда (docs/tasks/demo-tour.md) — корень. App монтирует его
// только гостю в демо-режиме. Здесь сходятся маршрут (хэш), шина событий продукта,
// хранение по id гостя и поиск цели в DOM; логика шагов — в чистой машине
// (tourMachine.ts), отрисовка — в TourLayer.
//
// Тур запускается сам, если для гостя ничего не сохранено (первый вход в песочницу);
// «Пропустить» и «Завершить» сохраняют «пройден», и сам он больше не появится —
// заново его запускает кнопка «?» в шапке (TourHelpButton).
import { useCallback, useEffect, useMemo, useReducer, useRef, useState, useSyncExternalStore } from "react";
import { fetchMe, getCanCreateProject, getMe, subscribeMe } from "../../api/auth";
import { nodesApi } from "../../api/nodes";
import { projectsApi } from "../../api/projects";
import { onTourEvent, type TourBusEvent } from "./tourBus";
import {
  availability, canGoBack, expandTarget, onScreen, reduceTour, screenHash, startState, stepTexts, stepTotal,
  type TourAction, type TourEnv, type TourSignal, type TourState,
} from "./tourMachine";
import { parseTourRoute, routeProject, type TourRoute } from "./tourRoute";
import { STEPS, YAR_PROJECT, type StepId } from "./tourSteps";
import { dropStaleTours, loadTour, onTourRestart, saveTour } from "./tourStore";
import { resolveTarget, topDialog } from "./tourTargets";
import TourLayer from "./TourLayer";
import { HIDDEN_VIEW, type TourView } from "./tourView";

/** Сколько ждать цель после входа в шаг или смены экрана, прежде чем считать, что
 *  пользователь ушёл в сторону (холст раскладывается не мгновенно). */
const GRACE_MS = 1500;

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
  return [v.phase, v.holes.map((h) => h.shape + rect(h)).join(";"), v.anchor ? rect(v.anchor) : "",
    v.avoid.map(rect).join(";")].join("|");
}

function TourRuntime({ userId }: { userId: string }) {
  const [raw, send] = useReducer(reducer, userId, initTour);
  const [route, setRoute] = useState<TourRoute>(() => parseTourRoute(window.location.hash));
  const [yarProjectId, setYarProjectId] = useState<string | null | undefined>(undefined);
  const [yarObjects, setYarObjects] = useState<ReadonlyMap<string, string> | undefined>(undefined);
  const [view, setView] = useState<TourView>(HIDDEN_VIEW);

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
  useEffect(() => { stateRef.current = state; }, [state]);
  useEffect(() => { envRef.current = env; }, [env]);

  const dispatch = useCallback((action: TourAction) => send({ action, env: envRef.current }), []);

  useEffect(() => { saveTour(userId, state); }, [userId, state]);

  // ── Маршрут ──
  useEffect(() => {
    const onHash = () => {
      const next = parseTourRoute(window.location.hash);
      routeRef.current = next;
      routeAtRef.current = performance.now();
      if (next.name !== "map") lastLevelRef.current = null;
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

  // ── «?»: пройти заново. Свой проект уже есть («Новый проект» погашена) — короткий
  // проход по «Ярмарке». Признак берём свежим с сервера: кэш «кто я» мог устареть.
  useEffect(() => onTourRestart(() => {
    void fetchMe().catch(() => undefined).then(() => {
      lastLevelRef.current = null;
      setYarProjectId(undefined); // «Ярмарку» ищем заново: её могли переименовать
      send({ reset: startState(getCanCreateProject() ? "full" : "short") });
    });
  }), []);

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
  // уйти в сторону сам, шаг подождёт его на своём экране.
  const navForRef = useRef<StepId | null>(raw.step);
  // Разовые действия входа в шаг: режим оболочки выставлен, цель прокручена, уже
  // раскрытый узел засчитан.
  const doneForRef = useRef({ mode: false, scroll: false, expanded: false });
  useEffect(() => {
    enteredAtRef.current = performance.now();
    doneForRef.current = { mode: false, scroll: false, expanded: false };
  }, [state.step]);
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

  // ── Кадровый цикл: цель в DOM, вырезы, окно поверх, сигналы DOM ──
  useEffect(() => {
    if (!running) return;
    let raf = 0;
    let lastKey = "";
    let lastHost: HTMLElement | null = null;
    const frame = () => {
      raf = requestAnimationFrame(frame);
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
        const res = screenOk && step.target
          ? resolveTarget(step.target, { yarProjectId: en.yarProjectId, yarObjects: en.yarObjects, vars: st.vars })
          : null;
        if (res && (!dialog || res.elements.every((el) => dialog.contains(el)))) {
          next = { phase: "spot", host: dialog ?? document.body, holes: res.holes, anchor: res.anchor, avoid: res.avoid };
          // Секции страницы объекта — к середине экрана, один раз на вход в шаг.
          if (step.target?.kind === "tour" && step.target.scroll && !doneForRef.current.scroll) {
            doneForRef.current.scroll = true;
            const el = res.elements[0];
            const tall = el.getBoundingClientRect().height > window.innerHeight * 0.6;
            el.scrollIntoView({ block: tall ? "start" : "center", behavior: "smooth" });
          }
        } else if (dialog) {
          // Открыто окно, а цель не в нём: окно работает, тур не мешает.
          next = HIDDEN_VIEW;
        } else {
          const since = Math.max(enteredAtRef.current, routeAtRef.current);
          next = { ...HIDDEN_VIEW, phase: performance.now() - since < GRACE_MS ? "pending" : "docked", host: document.body };
        }
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
      // «Новый проект»: окно открылось — шаг сделан; кнопка погашена — проект уже есть.
      if (st.step === "new-project") {
        if (document.querySelector('[data-tour="create-project"]')) {
          send({ action: { type: "signal", signal: { kind: "dom", key: "create-project" } }, env: en });
        } else if (document.querySelector('[data-tour="new-project"][aria-disabled="true"]')) {
          send({ action: { type: "blocked" }, env: en });
        }
      }
      const key = viewKey(next);
      if (key !== lastKey || next.host !== lastHost) {
        lastKey = key;
        lastHost = next.host;
        setView(next);
      }
    };
    raf = requestAnimationFrame(frame);
    return () => cancelAnimationFrame(raf);
  }, [running]);

  if (!running) return null;
  const step = STEPS[state.step];
  return (
    <TourLayer
      view={view}
      stepKey={state.step}
      step={step}
      texts={stepTexts(step, state.vars)}
      count={step.n !== undefined ? `Шаг ${step.n} из ${stepTotal(state.variant)}` : null}
      canBack={canGoBack(state.step)}
      onNext={() => dispatch({ type: "next" })}
      onBack={() => dispatch({ type: "back" })}
      onSkip={() => dispatch({ type: "skip" })}
      onFinish={() => dispatch({ type: "finish" })}
    />
  );
}
