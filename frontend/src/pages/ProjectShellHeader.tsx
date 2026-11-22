// Шапка оболочки проекта (редизайн, фаза 5): слева логотип, название проекта со списком
// проектов и режимы «Объекты», «Процессы» и «Развёртывание» текстовыми вкладками; справа
// тихие значки «Рекомендации» и «Действия со схемой» и профиль. Каркас — общий с шапкой
// редактора-карты (ui/ds.css, ds-head*): логотип стоит на одном месте на всех экранах
// проекта. Шапка — область нового языка (.ds), корень оболочки — нет: тело страниц
// размечено по частям.
import type { SchemaAlerts as AlertsData } from "../types";
import { getUserRole } from "../api/auth";
import SchemaAlerts, { type LocateTarget } from "../components/SchemaAlerts";
import SchemaActions, { type ExportScope } from "../components/SchemaActions";
import AccountMenu from "../components/users/AccountMenu";
import ProjectSwitcher from "../components/ProjectSwitcher";
import BrandLink from "../ui/BrandLink";
import type { WorkMode } from "./workMode";
import "../ui/ds.css";
import "./ProjectShellHeader.css";

interface Props {
  projectId: string;
  mode: WorkMode;
  onModeChange: (mode: WorkMode) => void;
  // Может ли человек править этот проект (роль в проекте): «Рекомендации», синк.
  isArchitect: boolean;
  alerts: AlertsData;
  onLocate: (target: LocateTarget) => void;
  onOpenProcess: (processId: string) => void;
  exportScope: ExportScope | null;
  onSynced: () => void;
  onLogout: () => void;
  onOpenUsers: () => void;
  onAllProjects: () => void;
  onSwitchProject: (id: string) => void;
}

export default function ProjectShellHeader({
  projectId, mode, onModeChange, isArchitect, alerts, onLocate, onOpenProcess, exportScope, onSynced,
  onLogout, onOpenUsers, onAllProjects, onSwitchProject,
}: Props) {
  return (
    <header className="ds-head ds">
      <div className="ds-head-left">
        <BrandLink onClick={onAllProjects} />
        <span className="ds-head-sep" aria-hidden="true" />
        <ProjectSwitcher
          projectId={projectId}
          // Списку проектов нужна ГЛОБАЛЬНАЯ роль: «Новый проект» — право architect.
          isArchitect={getUserRole() === "architect"}
          onAllProjects={onAllProjects}
          onSwitchProject={onSwitchProject}
        />
        <ModeTabs mode={mode} onChange={onModeChange} />
      </div>

      <div className="ds-head-acts">
        <div className="ds-head-icons">
          {/* «Рекомендации» (кто правит проект): клик по строке ведёт на страницу объекта,
              в редактор-карту или в процесс. Панель на новом языке, как в редакторе. */}
          {isArchitect && (
            <SchemaAlerts alerts={alerts} onLocate={onLocate} onOpenProcess={onOpenProcess} />
          )}
          <SchemaActions
            projectId={projectId}
            isArchitect={isArchitect}
            exportScope={exportScope}
            // В «Процессах» обновлять из кода нечего.
            syncHidden={mode === "proc"}
            onSynced={onSynced}
          />
        </div>
        <AccountMenu onLogout={onLogout} onOpenUsers={onOpenUsers} />
      </div>
    </header>
  );
}

// Режимы оболочки — текстовые вкладки нового языка: активная подчёркнута. Значков,
// подложки и подсказок нет: подпись и так говорит, что за режим. Якоря обучающего тура
// (data-tour) — на самих вкладках: тур нажимает их и обводит рамкой.
const MODES: readonly { mode: WorkMode; label: string; tour: string }[] = [
  { mode: "schema", label: "Объекты", tour: "mode-schema" },
  { mode: "proc", label: "Процессы", tour: "mode-proc" },
  { mode: "deploy", label: "Развёртывание", tour: "mode-deploy" },
];

function ModeTabs({ mode, onChange }: { mode: WorkMode; onChange: (m: WorkMode) => void }) {
  return (
    <nav className="ds-tabs psh-modes" aria-label="Режим">
      {MODES.map((m) => {
        const active = m.mode === mode;
        return (
          <button
            key={m.mode}
            type="button"
            className={"ds-tab" + (active ? " is-active" : "")}
            aria-current={active ? "page" : undefined}
            data-tour={m.tour}
            onClick={() => onChange(m.mode)}
          >
            {m.label}
          </button>
        );
      })}
    </nav>
  );
}
