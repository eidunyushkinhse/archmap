// Роль текущего пользователя в открытом проекте (docs/tasks/project-access.md).
// Права ВНУТРИ проекта решает только она: viewer может быть редактором чужого
// проекта, architect без роли редактора проект не правит. Глобальная роль
// (getUserRole) остаётся только для кнопок создания проекта.
//
// Роль грузит ProjectAccessGate (обёртка маршрутов проекта в App) и раздаёт
// контекстом: страницы проекта рендерятся уже со знанием роли, поэтому право
// правки стабильно с первого рендера (хуки вроде useSchemaAlerts читают его при
// маунте).
import { createContext, useContext } from "react";
import type { ProjectRole } from "../types";

// null — роли нет (вне гейта или проект не загрузился): только чтение.
export const ProjectRoleContext = createContext<ProjectRole | null>(null);

export function useProjectRole(): ProjectRole | null {
  return useContext(ProjectRoleContext);
}

/** Может ли роль править проект: схему, доки, процессы, факты, импорт. */
export function canEditProject(role: ProjectRole | null): boolean {
  return role === "owner" || role === "editor";
}
