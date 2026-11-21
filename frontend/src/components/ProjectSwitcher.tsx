import { useEffect, useRef, useState } from "react";
import { projectsApi } from "../api/projects";
import type { Project } from "../types";
import { CheckIcon, ChevronDownIcon } from "../ui/icons";
import CreateProjectDialog from "./project/CreateProjectDialog";
import { noAutofill } from "../ui/noAutofill";
import { useDismiss } from "../ui/useDismiss";
import "../ui/ds.css";
import "./ProjectSwitcher.css";

/**
 * Название проекта в шапке оболочки и список проектов под ним: поиск ТОЛЬКО по имени,
 * без превью/меты, выбор переключает проект, под чертой — «Новый проект» (тому, кто может
 * создавать) и «Все проекты». Закрытие по клику вне / Escape.
 * Имя не обрезается, пока в шапке есть место: ширину ограничивает только то, что от шапки
 * осталось (ProjectSwitcher.css). Вид — новый язык (редизайн, фаза 5): текст без рамки и
 * значка, меню на ds-menu.
 */

interface Props {
  projectId: string;
  isArchitect: boolean;
  onAllProjects: () => void;
  onSwitchProject: (id: string) => void;
}

export default function ProjectSwitcher({ projectId, isArchitect, onAllProjects, onSwitchProject }: Props) {
  const [open, setOpen] = useState(false);
  const [projects, setProjects] = useState<Project[]>([]);
  const [query, setQuery] = useState("");
  const [creating, setCreating] = useState(false);
  const ref = useRef<HTMLDivElement | null>(null);

  // Активные проекты — для имени текущего и списка. Тянем на маунте и держим (смена
  // проекта ремаунтит шапку целиком).
  useEffect(() => {
    let alive = true;
    projectsApi.list(false)
      .then((ps) => { if (alive) setProjects(ps); })
      .catch(() => { if (alive) setProjects([]); });
    return () => { alive = false; };
  }, []);

  useDismiss(open, ref, setOpen);

  const current = projects.find((p) => p.id === projectId);
  const name = current?.name ?? "Проект";
  const q = query.trim().toLowerCase();
  const filtered = q ? projects.filter((p) => p.name.toLowerCase().includes(q)) : projects;

  return (
    <div ref={ref} className="ps-wrap">
      <button type="button" className="ps-trigger" onClick={() => setOpen((o) => !o)} aria-haspopup="menu" aria-expanded={open}>
        {/* Полное имя в подсказке: когда места мало, оно обрезано многоточием. */}
        <span className="ps-name" title={name}>{name}</span>
        <span className="ps-chev" aria-hidden="true"><ChevronDownIcon /></span>
      </button>

      {open && (
        <div className="ds-menu ps-menu" role="menu">
          <div className="ps-search">
            <input
              {...noAutofill("project-switcher-1")}
              autoFocus
              className="ds-input"
              placeholder="Поиск проекта"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
          </div>
          <div className="ps-list">
            {filtered.length === 0 && <div className="ps-empty">Ничего не найдено</div>}
            {filtered.map((p) => {
              const isCurrent = p.id === projectId;
              return (
                <button
                  key={p.id}
                  type="button"
                  className="ds-menu-item"
                  role="menuitem"
                  aria-current={isCurrent ? "true" : undefined}
                  onClick={() => { setOpen(false); if (!isCurrent) onSwitchProject(p.id); }}
                >
                  <span className="ps-item-name" title={p.name}>{p.name}</span>
                  {isCurrent && <span className="ps-check" aria-hidden="true"><CheckIcon size={14} /></span>}
                </button>
              );
            })}
          </div>
          <div className="ds-menu-sep" role="separator" />
          {isArchitect && (
            <button type="button" className="ds-menu-item" role="menuitem" onClick={() => { setOpen(false); setCreating(true); }}>
              Новый проект
            </button>
          )}
          <button type="button" className="ds-menu-item" role="menuitem" onClick={() => { setOpen(false); onAllProjects(); }}>
            Все проекты
          </button>
        </div>
      )}

      {creating && (
        <CreateProjectDialog
          projects={projects}
          onClose={() => setCreating(false)}
          onCreated={(id) => { setCreating(false); onSwitchProject(id); }}
        />
      )}
    </div>
  );
}
