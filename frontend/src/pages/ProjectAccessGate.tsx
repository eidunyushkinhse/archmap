// Гейт маршрутов проекта: грузит карточку проекта (my_role) и рендерит страницы
// только после ответа, раздавая роль контекстом (projectRole.ts). Живёт над
// оболочкой и редактором-картой с ключом проекта: переход страница ↔ карта
// внутри проекта роль заново не грузит.
import { useEffect, useState } from "react";
import type { ReactNode } from "react";
import { projectsApi } from "../api/projects";
import type { ProjectRole } from "../types";
import { ProjectRoleContext } from "./projectRole";

interface Props {
  projectId: string;
  children: ReactNode;
}

export default function ProjectAccessGate({ projectId, children }: Props) {
  // undefined — ещё грузим; null — карточку получить не удалось (страницы сами
  // покажут свою ошибку, как и раньше), права при этом только на чтение.
  const [role, setRole] = useState<ProjectRole | null | undefined>(undefined);

  useEffect(() => {
    let alive = true;
    projectsApi
      .get(projectId)
      .then((p) => { if (alive) setRole(p.my_role); })
      .catch(() => { if (alive) setRole(null); });
    return () => { alive = false; };
  }, [projectId]);

  if (role === undefined) return null;
  return <ProjectRoleContext.Provider value={role}>{children}</ProjectRoleContext.Provider>;
}
