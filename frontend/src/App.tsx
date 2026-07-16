import { useEffect, useState } from "react";
import { clearToken, getToken } from "./api/auth";
import { setCurrentProjectId } from "./api/projectScope";
import LoginPage from "./pages/LoginPage";
import ProjectsPage from "./pages/ProjectsPage";
import TreePage from "./pages/TreePage";

// Минимальный хэш-роутер: #/projects — лендинг, #/p/<id> — схема проекта.
// react-router не тянем: маршрутов всего два.
type Route = { name: "projects" } | { name: "tree"; projectId: string };

function parseHash(): Route {
  const m = window.location.hash.replace(/^#/, "").match(/^\/p\/([0-9a-fA-F-]+)/);
  return m ? { name: "tree", projectId: m[1] } : { name: "projects" };
}

// Скоуп проекта (X-Project-Id) обязан быть выставлен ДО маунта TreePage: его
// mount-эффект грузит уровень РАНЬШЕ эффектов App (эффекты родителя исполняются
// после эффектов ребёнка), и установка скоупа эффектом опаздывала — первые
// запросы уровня уходили со старым/пустым заголовком (гонка X-Project-Id,
// баг prod-сборки 2026-07-14, починен 2026-07-16). Поэтому скоуп ставится
// СИНХРОННО при каждом разборе маршрута; setCurrentProjectId идемпотентен.
function routeFromHash(): Route {
  const route = parseHash();
  setCurrentProjectId(route.name === "tree" ? route.projectId : null);
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
