import { useCallback, useEffect, useState } from "react";
import type { ReactNode } from "react";
import { listToast as toastStyle } from "../ui/pageChrome";
import { fetchMe, getCanCreateProject, getIsGuest, getMe, getUserRole } from "../api/auth";
import { projectsApi } from "../api/projects";
import type { Project } from "../types";
import CreateProjectDialog from "../components/project/CreateProjectDialog";
import EditProjectDialog from "../components/project/EditProjectDialog";
import ProjectAccessDialog from "../components/project/ProjectAccessDialog";
import { ArchiveDialog, DeleteForeverDialog, RestoreDialog } from "../components/project/ProjectDialogs";
import ProjectCard from "../components/project/ProjectCard";
import AccountMenu from "../components/users/AccountMenu";
import BrandLink from "../ui/BrandLink";
import { noAutofill } from "../ui/noAutofill";
import { useMessageToast } from "./useToast";
import "../ui/ds.css";
import "./listPages.css";

/**
 * Экран «Проекты» (редизайн, фаза 12а): сетка карточек с мини-схемой, именем и описанием
 * (components/project/ProjectCard). Вкладки «Активные» и «Архив», поиск, пустые состояния.
 * Открытие проекта — щелчок по превью или тексту карточки. Создать проект — глобальная роль
 * architect; управлять им (редактировать, архив, восстановить, удалить) — только его
 * владелец (my_role); окно «Доступ» открывает каждый, кто видит проект (не-владельцу — на
 * чтение). Корень — область нового языка (.ds), шапка — общий каркас ds-head (ui/ds.css),
 * стили страницы — listPages.css (общий с экраном «Пользователи»).
 *
 * Гость демо-стенда (docs/tasks/demo-mode.md): над заголовком предупреждение песочницы,
 * «Доступа» нет, а «Новый проект» заперта с подсказкой, когда свой проект уже есть (решает
 * сервер: can_create_project в /auth/me).
 */

interface Props {
  onOpenProject: (id: string) => void;
  onLogout: () => void;
  // Экран «Пользователи» — пункт меню профиля, виден только администратору.
  onOpenUsers: () => void;
}

type Tab = "active" | "archived";
type Dialog =
  | { kind: "create" }
  | { kind: "edit" | "archive" | "restore" | "delete" | "access"; project: Project }
  | null;

export default function ProjectsPage({ onOpenProject, onLogout, onOpenUsers }: Props) {
  const isArchitect = getUserRole() === "architect";
  const isGuest = getIsGuest();
  // Гостю: создать ещё один проект можно, только пока предел не выбран.
  const createBlocked = isGuest && !getCanCreateProject();
  const guestName = isGuest ? (getMe()?.username ?? null) : null;
  const [active, setActive] = useState<Project[]>([]);
  const [archived, setArchived] = useState<Project[]>([]);
  const [tab, setTab] = useState<Tab>("active");
  const [query, setQuery] = useState("");
  const [dialog, setDialog] = useState<Dialog>(null);
  // Тост результата действия: таймер с очисткой и продлением (раньше — setTimeout без
  // очистки, аудит F-17).
  const [toast, flash] = useMessageToast(2600);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(async () => {
    setError(null);
    // Гостю «можно ли создать ещё» пересчитывает сервер: список мог измениться.
    if (getIsGuest()) fetchMe().catch(() => {});
    try {
      const [a, ar] = await Promise.all([projectsApi.list(false), projectsApi.list(true)]);
      setActive(a);
      setArchived(ar);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : "Не удалось загрузить проекты");
    } finally {
      setLoading(false);
    }
  }, []);

  // eslint-disable-next-line react-hooks/set-state-in-effect -- первичная загрузка списков при маунте (reload асинхронно тянет проекты и кладёт в стейт)
  useEffect(() => { void reload(); }, [reload]);

  const list = tab === "active" ? active : archived;
  const q = query.trim().toLowerCase();
  const filtered = q
    ? list.filter(
        (p) => p.name.toLowerCase().includes(q) || (p.description ?? "").toLowerCase().includes(q),
      )
    : list;

  return (
    <div className="ds lp-page">
      {/* Шапка: логотип без ссылки (экран и так «Все проекты») и меню профиля. */}
      <header className="ds-head">
        <div className="ds-head-left">
          <BrandLink />
        </div>
        <div className="ds-head-acts">
          <AccountMenu onLogout={onLogout} onOpenUsers={onOpenUsers} />
        </div>
      </header>

      <main className="lp-main">
        {isGuest && (
          <p className="ds-warn lp-sandbox" role="note">
            <strong>Это песочница.</strong> Она удалится через сутки бездействия. Не вносите сюда рабочие данные.
          </p>
        )}
        <div className="lp-title-row">
          <h1 className="lp-title">Проекты</h1>
          {isArchitect && (createBlocked ? (
            <BlockedNewButton />
          ) : (
            <button
              type="button"
              className="ds-btn ds-btn--primary"
              data-tour="new-project"
              onClick={() => setDialog({ kind: "create" })}
            >
              Новый проект
            </button>
          ))}
        </div>

        {/* Строка управления: вкладки слева, поиск справа. */}
        <div className="lp-controls">
          <div className="ds-tabs">
            <TabBtn active={tab === "active"} onClick={() => setTab("active")}>Активные</TabBtn>
            <TabBtn active={tab === "archived"} onClick={() => setTab("archived")}>Архив</TabBtn>
          </div>
          <input
            {...noAutofill("projects-page-1")}
            className="ds-input lp-search"
            placeholder="Поиск по имени или описанию"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        </div>

        {error && <p className="ds-danger lp-note">{error}</p>}
        {loading && <p className="ds-empty lp-note">Загрузка</p>}

        {!loading && filtered.length === 0 ? (
          <EmptyState
            tab={tab}
            hasQuery={q.length > 0}
            isArchitect={isArchitect && !createBlocked}
            onCreate={() => setDialog({ kind: "create" })}
          />
        ) : (
          <div className="lp-grid">
            {filtered.map((p) => (
              <ProjectCard
                key={p.id}
                project={p}
                archivedTab={tab === "archived"}
                canShare={!isGuest}
                updaterLabel={guestName !== null && p.updated_by === guestName ? "Гость" : undefined}
                onOpen={() => onOpenProject(p.id)}
                onAccess={() => setDialog({ kind: "access", project: p })}
                onEdit={() => setDialog({ kind: "edit", project: p })}
                onArchive={() => setDialog({ kind: "archive", project: p })}
                onRestore={() => setDialog({ kind: "restore", project: p })}
                onDelete={() => setDialog({ kind: "delete", project: p })}
              />
            ))}
          </div>
        )}
      </main>

      {/* Диалоги */}
      {dialog?.kind === "create" && (
        <CreateProjectDialog
          projects={active}
          onClose={() => setDialog(null)}
          onCreated={(id) => { setDialog(null); onOpenProject(id); }}
        />
      )}
      {dialog?.kind === "edit" && (
        <EditProjectDialog
          project={dialog.project}
          onClose={() => setDialog(null)}
          onSaved={() => { setDialog(null); flash("Проект обновлён"); void reload(); }}
        />
      )}
      {dialog?.kind === "access" && (
        <ProjectAccessDialog
          project={dialog.project}
          onClose={() => setDialog(null)}
          onChanged={() => void reload()}
        />
      )}
      {dialog?.kind === "archive" && (
        <ArchiveDialog
          project={dialog.project}
          onClose={() => setDialog(null)}
          onDone={() => { setDialog(null); flash("Проект отправлен в архив"); void reload(); }}
        />
      )}
      {dialog?.kind === "restore" && (
        <RestoreDialog
          project={dialog.project}
          onClose={() => setDialog(null)}
          onDone={() => { setDialog(null); flash("Проект восстановлен"); void reload(); }}
        />
      )}
      {dialog?.kind === "delete" && (
        <DeleteForeverDialog
          project={dialog.project}
          onClose={() => setDialog(null)}
          onDone={() => { setDialog(null); flash("Проект удалён"); void reload(); }}
        />
      )}

      {/* Тост прежнего вида (legacy-root держит прежние метрики текста внутри .ds). */}
      {toast && <div className="legacy-root" style={toastStyle}>{toast}</div>}
    </div>
  );
}

// Подсказка к запертой кнопке (docs/tasks/demo-mode.md, экран 2).
const GUEST_LIMIT_HINT = "В демо можно создать один свой проект. Удалите его, чтобы создать другой.";

// «Новый проект», когда гость уже держит предельное число проектов: кнопка видна, но
// не действует; по наведению и фокусу — подсказка, что делать.
function BlockedNewButton() {
  const [tip, setTip] = useState(false);
  return (
    <span
      className="lp-locked"
      onMouseEnter={() => setTip(true)}
      onMouseLeave={() => setTip(false)}
    >
      <button
        type="button"
        className="ds-btn ds-btn--primary lp-locked-btn"
        data-tour="new-project"
        aria-disabled="true"
        aria-describedby={tip ? "guest-limit-tip" : undefined}
        onFocus={() => setTip(true)}
        onBlur={() => setTip(false)}
      >
        Новый проект
      </button>
      {tip && <span id="guest-limit-tip" role="tooltip" className="lp-tip">{GUEST_LIMIT_HINT}</span>}
    </span>
  );
}

// Пустой список: промах поиска и пустой архив — тихим абзацем; первое открытие — заголовок,
// пояснение и (кому можно создавать) главная кнопка. Без коробки, прижато влево.
function EmptyState({
  tab, hasQuery, isArchitect, onCreate,
}: { tab: Tab; hasQuery: boolean; isArchitect: boolean; onCreate: () => void }) {
  if (hasQuery) return <p className="ds-empty lp-note">Ничего не найдено</p>;
  if (tab === "archived") return <p className="ds-empty lp-note">В архиве пусто</p>;
  return (
    <div className="lp-first">
      <h2 className="lp-first-title">Пока нет ни одного проекта</h2>
      <p className="lp-first-lead">Создайте первый проект. В каждом проекте своя изолированная схема системы.</p>
      {isArchitect && (
        <button type="button" className="ds-btn ds-btn--primary" onClick={onCreate}>Создать первый проект</button>
      )}
    </div>
  );
}

// Вкладка-текст нового языка: выбранная подчёркнута и нажата (aria-pressed).
function TabBtn({ active, onClick, children }: { active: boolean; onClick: () => void; children: ReactNode }) {
  return (
    <button
      type="button"
      className={"ds-tab" + (active ? " is-active" : "")}
      aria-pressed={active}
      onClick={onClick}
    >
      {children}
    </button>
  );
}
