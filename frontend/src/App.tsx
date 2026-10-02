import { useEffect, useState, useSyncExternalStore } from "react";
import { clearToken, fetchMe, getMe, getToken, subscribeMe } from "./api/auth";
import { onAccountBlocked } from "./api/client";
import { setCurrentProjectId } from "./api/projectScope";
import LoginPage from "./pages/LoginPage";
import ProjectsPage from "./pages/ProjectsPage";
import ProjectShell from "./pages/ProjectShell";
import MapEditorPage from "./pages/MapEditorPage";
import ProjectAccessGate from "./pages/ProjectAccessGate";
import UsersPage from "./pages/UsersPage";

// Минимальный хэш-роутер: #/projects — лендинг, #/p/<id> — страница проекта,
// #/p/<id>/nodes/<nodeId> — страница объекта, #/p/<id>/map/<nodeId?> — редактор-карта,
// #/admin/users — экран «Пользователи» (администратор).
type Route =
  | { name: "projects" }
  | { name: "users" }
  | { name: "node"; projectId: string; nodeId: string }
  | { name: "project-home"; projectId: string }
  | { name: "map"; projectId: string; nodeId: string | null; locate: string | null; ret: string | null };

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
  // #/p/<pid>/nodes/<nodeId>
  const nodeMatch = hash.match(/^\/p\/([0-9a-fA-F-]+)\/nodes\/([0-9a-fA-F-]+)/);
  if (nodeMatch) return { name: "node", projectId: nodeMatch[1], nodeId: nodeMatch[2] };
  // #/p/<pid>
  const projMatch = hash.match(/^\/p\/([0-9a-fA-F-]+)/);
  if (projMatch) return { name: "project-home", projectId: projMatch[1] };
  return { name: "projects" };
}

// Скоуп проекта (X-Project-Id) обязан быть выставлен ДО маунта страниц: их
// mount-эффект грузит уровень РАНЬШЕ эффектов App (эффекты родителя исполняются
// после эффектов ребёнка), и установка скоупа эффектом опаздывала — первые
// запросы уровня уходили со старым/пустым заголовком (гонка X-Project-Id,
// баг prod-сборки 2026-07-14, починен 2026-07-16). Поэтому скоуп ставится
// СИНХРОННО при каждом разборе маршрута; setCurrentProjectId идемпотентен.
function routeFromHash(): Route {
  const route = parseHash();
  // Скоуп проекта нужен всем маршрутам внутри проекта (node, project-home, map)
  const pid = "projectId" in route ? route.projectId : null;
  setCurrentProjectId(pid);
  return route;
}

export default function App() {
  const [authenticated, setAuthenticated] = useState(!!getToken());
  const [route, setRoute] = useState<Route>(routeFromHash);
  // Почему выкинули на экран входа (блокировка) — текст для LoginPage.
  const [loginNotice, setLoginNotice] = useState<string | null>(null);
  // «Кто я» (роль и признак администратора из БД) — внешний стор api/auth. Подписка
  // перерисовывает дерево, когда ответ /auth/me пришёл: страницы зовут синхронный
  // getUserRole() в рендере и видят свежую роль, а не записанную в токен при входе.
  useSyncExternalStore(subscribeMe, getMe);

  useEffect(() => {
    const onHash = () => setRoute(routeFromHash());
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);

  // При старте и после каждого входа — загрузить «кто я». Отказ не ломает экран:
  // до ответа (и без него) действует роль из токена; 401 блокировки ловит подписка ниже.
  useEffect(() => {
    if (!authenticated) return;
    fetchMe().catch(() => {});
  }, [authenticated]);

  // Учётку заблокировали, пока человек работал: любой запрос получил 401 с этим
  // текстом — выходим на экран входа и показываем причину.
  useEffect(
    () =>
      onAccountBlocked((message) => {
        clearToken();
        setCurrentProjectId(null);
        setLoginNotice(message);
        setAuthenticated(false);
        window.location.hash = "/projects";
      }),
    [],
  );

  function navigate(hash: string) {
    window.location.hash = hash;
  }

  function handleLogout() {
    clearToken();
    setCurrentProjectId(null);
    setLoginNotice(null);
    setAuthenticated(false);
    navigate("/projects");
  }

  if (!authenticated) {
    return (
      <LoginPage
        notice={loginNotice}
        onLogin={() => { setLoginNotice(null); setAuthenticated(true); }}
      />
    );
  }

  if (route.name === "users") {
    return <UsersPage onAllProjects={() => navigate("/projects")} onLogout={handleLogout} />;
  }

  // Маршруты внутри проекта: редактор-карта и оболочка (страница проекта/узла).
  // Над ними — гейт роли в проекте (my_role): права правки решает она, а не
  // глобальная роль. Ключ гейта — проект: переход страница ↔ карта роль не
  // перегружает, смена проекта — перегружает.
  if (route.name === "map" || route.name === "node" || route.name === "project-home") {
    const pid = route.projectId;
    return (
      <ProjectAccessGate key={pid} projectId={pid}>
        {route.name === "map" ? (
          // pages_pivot: редактор-карта
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
        ) : (
          // pages_pivot: страница узла или страница проекта (ProjectShell)
          <ProjectShell
            key={pid}
            projectId={pid}
            nodeId={route.name === "node" ? route.nodeId : null}
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
        )}
      </ProjectAccessGate>
    );
  }

  return (
    <ProjectsPage
      onOpenProject={(id) => navigate(`/p/${id}`)}
      onLogout={handleLogout}
      onOpenUsers={() => navigate("/admin/users")}
    />
  );
}
