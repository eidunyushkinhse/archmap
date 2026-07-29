import { useEffect, useState } from "react";
import { clearToken, getToken } from "./api/auth";
import { setCurrentProjectId } from "./api/projectScope";
import { isPagesPivot } from "./featureFlags";
import LoginPage from "./pages/LoginPage";
import ProjectsPage from "./pages/ProjectsPage";
import TreePage from "./pages/TreePage";
import ProjectShell from "./pages/ProjectShell";
import MapEditorPage from "./pages/MapEditorPage";

// Минимальный хэш-роутер: #/projects — лендинг, #/p/<id> — схема проекта,
// #/p/<id>/nodes/<nodeId> — страница объекта, #/p/<id>/map/<nodeId?> — редактор-карта.
type Route =
  | { name: "projects" }
  | { name: "tree"; projectId: string }
  | { name: "node"; projectId: string; nodeId: string }
  | { name: "project-home"; projectId: string }
  | { name: "map"; projectId: string; nodeId: string | null };

function parseHash(): Route {
  const hash = window.location.hash.replace(/^#/, "");
  // #/p/<pid>/map/<nodeId> или #/p/<pid>/map
  const mapMatch = hash.match(/^\/p\/([0-9a-fA-F-]+)\/map(?:\/([0-9a-fA-F-]+))?/);
  if (mapMatch) return { name: "map", projectId: mapMatch[1], nodeId: mapMatch[2] ?? null };
  // #/p/<pid>/nodes/<nodeId>
  const nodeMatch = hash.match(/^\/p\/([0-9a-fA-F-]+)\/nodes\/([0-9a-fA-F-]+)/);
  if (nodeMatch) return { name: "node", projectId: nodeMatch[1], nodeId: nodeMatch[2] };
  // #/p/<pid>
  const projMatch = hash.match(/^\/p\/([0-9a-fA-F-]+)/);
  if (projMatch) {
    // pages_pivot: индекс проекта → страница проекта; иначе → старый TreePage
    return isPagesPivot()
      ? { name: "project-home", projectId: projMatch[1] }
      : { name: "tree", projectId: projMatch[1] };
  }
  return { name: "projects" };
}

// Скоуп проекта (X-Project-Id) обязан быть выставлен ДО маунта TreePage: его
// mount-эффект грузит уровень РАНЬШЕ эффектов App (эффекты родителя исполняются
// после эффектов ребёнка), и установка скоупа эффектом опаздывала — первые
// запросы уровня уходили со старым/пустым заголовком (гонка X-Project-Id,
// баг prod-сборки 2026-07-14, починен 2026-07-16). Поэтому скоуп ставится
// СИНХРОННО при каждом разборе маршрута; setCurrentProjectId идемпотентен.
function routeFromHash(): Route {
  const route = parseHash();
  // Скоуп проекта нужен всем маршрутам внутри проекта (tree, node, project-home)
  const pid = route.name === "projects" ? null : route.projectId;
  setCurrentProjectId(pid);
  return route;
}

export default function App() {
  const [authenticated, setAuthenticated] = useState(!!getToken());
  const [route, setRoute] = useState<Route>(routeFromHash);

  useEffect(() => {
    const onHash = () => setRoute(routeFromHash());
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);

  function navigate(hash: string) {
    window.location.hash = hash;
  }

  function handleLogout() {
    clearToken();
    setCurrentProjectId(null);
    setAuthenticated(false);
    navigate("/projects");
  }

  if (!authenticated) {
    return <LoginPage onLogin={() => setAuthenticated(true)} />;
  }

  // pages_pivot: редактор-карта
  if (route.name === "map") {
    const pid = route.projectId;
    return (
      <MapEditorPage
        key={`${pid}:${route.nodeId ?? "root"}`}
        projectId={pid}
        nodeId={route.nodeId}
        onDone={(levelId) => {
          // «Готово» → страница текущего уровня
          if (levelId) navigate(`/p/${pid}/nodes/${levelId}`);
          else navigate(`/p/${pid}`);
        }}
        onNavigateNode={(nodeId) => navigate(`/p/${pid}/nodes/${nodeId}`)}
      />
    );
  }

  // pages_pivot: страница узла или страница проекта (ProjectShell)
  if (route.name === "node" || route.name === "project-home") {
    const pid = route.projectId;
    return (
      <ProjectShell
        key={pid}
        projectId={pid}
        nodeId={route.name === "node" ? route.nodeId : null}
        onLogout={handleLogout}
        onAllProjects={() => navigate("/projects")}
        onSwitchProject={(id) => navigate(`/p/${id}`)}
        onNavigateNode={(nodeId) => navigate(`/p/${pid}/nodes/${nodeId}`)}
        onNavigateProject={() => navigate(`/p/${pid}`)}
        onNavigateMap={(nodeId) => navigate(nodeId ? `/p/${pid}/map/${nodeId}` : `/p/${pid}/map`)}
      />
    );
  }

  if (route.name === "tree") {
    // key по projectId: смена проекта = полный ремаунт TreePage → свежая загрузка
    // корня нового проекта, сброс breadcrumb и истории Undo/Redo.
    return (
      <TreePage
        key={route.projectId}
        projectId={route.projectId}
        onLogout={handleLogout}
        onAllProjects={() => navigate("/projects")}
        onSwitchProject={(id) => navigate(`/p/${id}`)}
      />
    );
  }

  return (
    <ProjectsPage
      onOpenProject={(id) => navigate(`/p/${id}`)}
      onLogout={handleLogout}
    />
  );
}
