import { lazy, Suspense, useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import {
  clearToken, fetchAuthConfig, fetchMe, getAuthConfig, getIsGuest, getMe, getToken, subscribeMe,
} from "./api/auth";
import { onAccountBlocked, onUnauthorized } from "./api/client";
import { setCurrentProjectId } from "./api/projectScope";
import { deployRemembered } from "./pages/workMode";
import type { AuthConfig } from "./types";
import DemoLoginPage from "./pages/DemoLoginPage";
import LoginPage from "./pages/LoginPage";
import ProjectAccessGate from "./pages/ProjectAccessGate";
import ErrorBoundary from "./ui/ErrorBoundary";

// Страницы после входа — отдельными чанками (аудит R-19): экран входа не качает
// редактор схем, процессы, окна агента и тур — ~80% прежнего входного чанка. Пока
// чанк едет — пусто (страницы сами показывают загрузку данных); не доехал (выкат
// сменил имена файлов) — ловит граница ошибок страницы с «Обновить страницу».
const ProjectsPage = lazy(() => import("./pages/ProjectsPage"));
const ProjectShell = lazy(() => import("./pages/ProjectShell"));
const MapEditorPage = lazy(() => import("./pages/MapEditorPage"));
const UsersPage = lazy(() => import("./pages/UsersPage"));
const DemoTour = lazy(() => import("./components/tour/DemoTour"));

// Минимальный хэш-роутер: #/projects — лендинг, #/p/<id> — страница проекта,
// #/p/<id>/nodes/<nodeId> — страница объекта, #/p/<id>/map/<nodeId?> — редактор-карта,
// #/p/<id>/deploy/<nodeId?> — режим «Развёртывание» на уровне контейнера (без него — весь
// проект), #/admin/users — экран «Пользователи» (администратор).
type Route =
  | { name: "projects" }
  | { name: "users" }
  | { name: "node"; projectId: string; nodeId: string }
  | { name: "project-home"; projectId: string }
  | { name: "deploy"; projectId: string; nodeId: string | null }
  | { name: "map"; projectId: string; nodeId: string | null; locate: string | null; ret: string | null };

const deployHash = (projectId: string, level: string | null): string =>
  level ? `/p/${projectId}/deploy/${level}` : `/p/${projectId}/deploy`;

function parseHash(): Route {
  const hash = window.location.hash.replace(/^#/, "");
  if (/^\/admin\/users(?:[/?]|$)/.test(hash)) return { name: "users" };
  // #/p/<pid>/map/<levelId>?locate=<nodeId>&ret=<return> (или #/p/<pid>/map?…)
  const mapMatch = hash.match(/^\/p\/([0-9a-fA-F-]+)\/map(?:\/([0-9a-fA-F-]+))?(?:\?(.*))?/);
  if (mapMatch) {
    const q = new URLSearchParams(mapMatch[3] ?? "");
    return {
      name: "map",
      projectId: mapMatch[1],
      nodeId: mapMatch[2] ?? null,
      locate: q.get("locate"),
      ret: q.get("ret"),
    };
  }
  // #/p/<pid>/deploy/<levelId> (или #/p/<pid>/deploy — весь проект)
  const deployMatch = hash.match(/^\/p\/([0-9a-fA-F-]+)\/deploy(?:\/([0-9a-fA-F-]+))?(?:[/?]|$)/);
  if (deployMatch) return { name: "deploy", projectId: deployMatch[1], nodeId: deployMatch[2] ?? null };
  // #/p/<pid>/nodes/<nodeId>
  const nodeMatch = hash.match(/^\/p\/([0-9a-fA-F-]+)\/nodes\/([0-9a-fA-F-]+)/);
  if (nodeMatch) return { name: "node", projectId: nodeMatch[1], nodeId: nodeMatch[2] };
  // #/p/<pid>
  const projMatch = hash.match(/^\/p\/([0-9a-fA-F-]+)/);
  if (projMatch) return { name: "project-home", projectId: projMatch[1] };
  return { name: "projects" };
}

// Маршруты, которые рисует оболочка проекта (ProjectShell): между ними она не перемонтируется.
const inShell = (r: Route | null, projectId: string): boolean =>
  r !== null && (r.name === "project-home" || r.name === "node" || r.name === "deploy") && r.projectId === projectId;

// Скоуп проекта (X-Project-Id) обязан быть выставлен ДО маунта страниц: их
// mount-эффект грузит уровень РАНЬШЕ эффектов App (эффекты родителя исполняются
// после эффектов ребёнка), и установка скоупа эффектом опаздывала — первые
// запросы уровня уходили со старым/пустым заголовком (гонка X-Project-Id,
// баг prod-сборки 2026-07-14, починен 2026-07-16). Поэтому скоуп ставится
// СИНХРОННО при каждом разборе маршрута; setCurrentProjectId идемпотентен.
// prev — маршрут, показанный до этого (null — первый разбор при загрузке).
function routeFromHash(prev: Route | null): Route {
  let route = parseHash();
  // Запомненный режим «Развёртывание» живёт в адресе: ОТКРЫТИЕ страницы проекта (загрузка,
  // переход из списка, другого проекта или редактора-карты) ведёт сразу на
  // #/p/<pid>/deploy. Адрес ЗАМЕНЯЕТСЯ (replaceState, без hashchange), а не добавляется:
  // иначе «назад» вёл бы на #/p/<pid> и тут же обратно сюда. Внутри открытой оболочки
  // #/p/<pid> — это «Объекты»/«Процессы»: так «назад» из «Развёртывания» возвращает режим.
  if (route.name === "project-home" && !inShell(prev, route.projectId) && deployRemembered()) {
    route = { name: "deploy", projectId: route.projectId, nodeId: null };
    window.history.replaceState(window.history.state, "", `#${deployHash(route.projectId, null)}`);
  }
  // Скоуп проекта нужен всем маршрутам внутри проекта (node, project-home, deploy, map)
  const pid = "projectId" in route ? route.projectId : null;
  setCurrentProjectId(pid);
  return route;
}

// Плашка экрана входа, когда сессия закончилась сама (токен истёк), а не по выходу.
export const SESSION_EXPIRED_NOTICE = "Сессия истекла — войдите снова.";

export default function App() {
  const [authenticated, setAuthenticated] = useState(!!getToken());
  const [route, setRoute] = useState<Route>(() => routeFromHash(null));
  // Показанный маршрут для разбора следующего адреса (редирект «Развёртывания» — только
  // при открытии проекта, см. routeFromHash).
  const shownRoute = useRef(route);
  // Почему выкинули на экран входа (блокировка, удалённая песочница) — текст плашки.
  const [loginNotice, setLoginNotice] = useState<string | null>(null);
  // Публичные настройки входа: демо-стенд показывает свой экран входа
  // (docs/tasks/demo-mode.md). До ответа экран входа не рисуем, чтобы не мелькнуть
  // формой логина там, где её нет.
  const [authConfig, setAuthConfig] = useState<AuthConfig | null>(getAuthConfig);
  // «Кто я» (роль и признак администратора из БД) — внешний стор api/auth. Подписка
  // перерисовывает дерево, когда ответ /auth/me пришёл: страницы зовут синхронный
  // getUserRole() в рендере и видят свежую роль, а не записанную в токен при входе.
  useSyncExternalStore(subscribeMe, getMe);

  useEffect(() => {
    const onHash = () => {
      const next = routeFromHash(shownRoute.current);
      shownRoute.current = next;
      setRoute(next);
    };
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);

  // При старте и после каждого входа — загрузить «кто я». Отказ не ломает экран:
  // до ответа (и без него) действует роль из токена; 401 блокировки ловит подписка ниже.
  useEffect(() => {
    if (!authenticated) return;
    fetchMe().catch(() => {});
  }, [authenticated]);

  useEffect(() => {
    let alive = true;
    void fetchAuthConfig().then((cfg) => { if (alive) setAuthConfig(cfg); });
    return () => { alive = false; };
  }, []);

  // Конец сессии — один на выход, блокировку и истёкший токен (аудит F-67): токен и
  // открытый проект забываются, экран входа показывает notice. toProjects — начать
  // после входа со «Всех проектов»; иначе адрес сохраняется и человек вернётся туда же.
  const resetSession = useCallback((notice: string | null, toProjects: boolean) => {
    clearToken();
    setCurrentProjectId(null);
    setLoginNotice(notice);
    setAuthenticated(false);
    if (toProjects) window.location.hash = "/projects";
  }, []);

  // Учётку заблокировали (или песочницу гостя убрали), пока человек работал: любой
  // запрос получил 401 с этим текстом — выходим на экран входа и показываем причину.
  useEffect(() => onAccountBlocked((message) => { resetSession(message, true); }), [resetSession]);

  // Прочий 401 (токен истёк или испорчен) — на экран входа. Раньше это делал только
  // демо-стенд, а вне демо страницы молча оставались пустыми (аудит R-15). Вне демо —
  // плашка с причиной, и адрес страницы сохраняется: после входа человек вернётся
  // туда же. Гость демо — на «Все проекты» без плашки: его новая песочница — другой проект.
  const demoMode = authConfig?.demo_mode ?? false;
  useEffect(() => {
    if (!authenticated) return;
    return onUnauthorized((reason) => { resetSession(demoMode ? null : (reason ?? SESSION_EXPIRED_NOTICE), demoMode); });
  }, [authenticated, demoMode, resetSession]);

  function navigate(hash: string) {
    window.location.hash = hash;
  }

  function handleLogout() {
    resetSession(null, true);
  }

  if (!authenticated) {
    if (authConfig === null) return null;
    const onLogin = () => { setLoginNotice(null); setAuthenticated(true); };
    return authConfig.demo_mode
      ? <DemoLoginPage key={loginNotice ?? ""} notice={loginNotice} onLogin={onLogin} />
      : <LoginPage notice={loginNotice} onLogin={onLogin} />;
  }

  // Обучающий тур — только гостю демо-стенда (docs/tasks/demo-tour.md): слой поверх
  // любой страницы, сам следит за маршрутом. Своя граница ошибок без карточки: упавший
  // тур просто исчезает, страница под ним живёт дальше.
  const tour = demoMode && getIsGuest() ? (
    <ErrorBoundary fallback={null}><Suspense fallback={null}><DemoTour /></Suspense></ErrorBoundary>
  ) : null;

  // Ключ сброса границ ошибок: ушли на другой маршрут — упавшую страницу пробуем снова.
  const resetKey = JSON.stringify(route);

  // Гостю демо-стенда экран «Пользователи» недоступен: ведём на «Все проекты».
  if (route.name === "users" && !getIsGuest()) {
    return (
      <ErrorBoundary resetKey={resetKey}>
        <Suspense fallback={null}>
          <UsersPage onAllProjects={() => navigate("/projects")} onLogout={handleLogout} />
        </Suspense>
      </ErrorBoundary>
    );
  }

  // Маршруты внутри проекта: редактор-карта и оболочка (страница проекта/узла).
  // Над ними — гейт роли в проекте (my_role): права правки решает она, а не
  // глобальная роль. Ключ гейта — проект: переход страница ↔ карта роль не
  // перегружает, смена проекта — перегружает.
  if (route.name === "map" || route.name === "node" || route.name === "project-home" || route.name === "deploy") {
    const pid = route.projectId;
    return (
      <>
        <ProjectAccessGate key={pid} projectId={pid}>
          {route.name === "map" ? (
            // pages_pivot: редактор-карта
            <ErrorBoundary resetKey={resetKey}>
              <Suspense fallback={null}>
                <MapEditorPage
                  key={`${pid}:${route.nodeId ?? "root"}:${route.locate ?? ""}`}
                  projectId={pid}
                  nodeId={route.nodeId}
                  locateNodeId={route.locate}
                  onAllProjects={() => navigate("/projects")}
                  onDone={() => {
                    // Ф12: возврат туда, откуда открыли (роут при закрытии не меняется).
                    // ret = "node:<id>" | "project" | null (по умолчанию — страница уровня).
                    const ret = route.ret;
                    if (ret?.startsWith("node:")) navigate(`/p/${pid}/nodes/${ret.slice(5)}`);
                    else if (ret === "project") navigate(`/p/${pid}`);
                    else navigate(`/p/${pid}`);
                  }}
                  onNavigateNode={(nodeId) => navigate(`/p/${pid}/nodes/${nodeId}`)}
                />
              </Suspense>
            </ErrorBoundary>
          ) : (
            // pages_pivot: страница узла, страница проекта или «Развёртывание» (ProjectShell;
            // ключ — проект: смена уровня и режима оболочку не перемонтирует)
            <ErrorBoundary resetKey={resetKey}>
              <Suspense fallback={null}>
                <ProjectShell
                  key={pid}
                  projectId={pid}
                  nodeId={route.name === "node" ? route.nodeId : null}
                  deploy={route.name === "deploy" ? { level: route.nodeId } : undefined}
                  onNavigateDeploy={(level) => navigate(deployHash(pid, level))}
                  onLogout={handleLogout}
                  onOpenUsers={() => navigate("/admin/users")}
                  onAllProjects={() => navigate("/projects")}
                  onSwitchProject={(id) => navigate(`/p/${id}`)}
                  onNavigateNode={(nodeId) => navigate(`/p/${pid}/nodes/${nodeId}`)}
                  onNavigateProject={() => navigate(`/p/${pid}`)}
                  onNavigateMap={(level, opts) => {
                    const q = new URLSearchParams();
                    if (opts?.locate) q.set("locate", opts.locate);
                    if (opts?.ret) q.set("ret", opts.ret);
                    const qs = q.toString();
                    navigate(level ? `/p/${pid}/map/${level}${qs ? `?${qs}` : ""}` : `/p/${pid}/map${qs ? `?${qs}` : ""}`);
                  }}
                />
              </Suspense>
            </ErrorBoundary>
          )}
        </ProjectAccessGate>
        {tour}
      </>
    );
  }

  return (
    <>
      <ErrorBoundary resetKey={resetKey}>
        <Suspense fallback={null}>
          <ProjectsPage
            onOpenProject={(id) => navigate(`/p/${id}`)}
            onLogout={handleLogout}
            onOpenUsers={() => navigate("/admin/users")}
          />
        </Suspense>
      </ErrorBoundary>
      {tour}
    </>
  );
}
