import { useState } from "react";
import type { Project } from "../../types";
import SchemaPreview from "./SchemaPreview";
import { KebabIcon } from "../../ui/icons";
import { useMenu } from "../../ui/useMenu";
import "../../ui/ds.css";
import "./projectCard.css";

/**
 * Карточка проекта на экране «Проекты» (редизайн, фаза 12а): превью схемы, имя и описание,
 * внизу тихой строкой кто менял последним и когда. Превью и текст открывают проект; меню —
 * кнопка-значок в углу превью, видна под курсором, при фокусе клавиатуры внутри карточки и
 * при открытом меню (projectCard.css). Меню — редактору и владельцу: «Открыть» и «Доступ»
 * обоим, управление проектом (редактировать, архив, восстановить, удалить) — только
 * владельцу. Читателю состав участников не показываем, а без «Доступа» в меню остался бы
 * один пункт «Открыть» — поэтому у читателя меню нет вовсе (и меток роли тоже нет).
 * Гостю демо-стенда «Доступ» не показываем (canShare=false): делиться ему не с кем.
 */
export default function ProjectCard({
  project, archivedTab, canShare = true, updaterLabel, onOpen, onAccess, onEdit, onArchive,
  onRestore, onDelete,
}: {
  project: Project;
  archivedTab: boolean;
  canShare?: boolean;
  // Подпись «кто менял» вместо логина (гость видит себя «Гостем», а не guest-…).
  updaterLabel?: string;
  onOpen: () => void;
  onAccess: () => void;
  onEdit: () => void;
  onArchive: () => void;
  onRestore: () => void;
  onDelete: () => void;
}) {
  const who = updaterLabel ?? project.updated_by;
  return (
    <div data-tour={`project:${project.id}`} className="project-card">
      {/* Меню — соседом кнопки превью, а не внутри неё: щелчок по меню проект не открывает. */}
      <div className="project-card-top">
        <button type="button" className="project-card-preview" onClick={onOpen} title="Открыть проект">
          <SchemaPreview preview={project.preview} />
        </button>
        {project.my_role !== "reader" && <CardMenu
          isOwner={project.my_role === "owner"}
          archivedTab={archivedTab}
          canShare={canShare}
          onOpen={onOpen}
          onAccess={onAccess}
          onEdit={onEdit}
          onArchive={onArchive}
          onRestore={onRestore}
          onDelete={onDelete}
        />}
      </div>
      <button type="button" className="project-card-body" onClick={onOpen}>
        <span className="project-card-name">{project.name}</span>
        <span className="project-card-desc">{project.description || "Без описания"}</span>
      </button>
      {/* Кто менял последним (длинный логин — с многоточием, целиком в подсказке) и дата. */}
      <div className="project-card-foot">
        <span className="project-card-who" title={who ?? undefined}>{who ?? "—"}</span>
        <span className="project-card-date">{fmtDate(project.updated_at)}</span>
      </div>
    </div>
  );
}

function CardMenu({
  isOwner, archivedTab, canShare, onOpen, onAccess, onEdit, onArchive, onRestore, onDelete,
}: {
  isOwner: boolean;
  archivedTab: boolean;
  canShare: boolean;
  onOpen: () => void;
  onAccess: () => void;
  onEdit: () => void;
  onArchive: () => void;
  onRestore: () => void;
  onDelete: () => void;
}) {
  const [open, setOpen] = useState(false);
  // Закрытие, стрелки и возврат фокуса на кнопку меню — общим хуком ui/useMenu.
  const { wrapRef, triggerRef, menuRef, onKeyDown, pick } = useMenu(open, setOpen);
  // Пункт меню: фокус на кнопку меню, закрывает меню и зовёт действие; «Удалить навсегда» —
  // опасным пунктом.
  const item = (label: string, fn: () => void, danger = false) => (
    <button
      type="button"
      className={"ds-menu-item" + (danger ? " ds-menu-item--danger" : "")}
      onClick={() => pick(fn)}
    >
      {label}
    </button>
  );
  return (
    <div ref={wrapRef} className="project-card-menu">
      <button
        ref={triggerRef}
        type="button"
        className="ds-icon-btn project-card-kebab"
        onClick={() => setOpen((o) => !o)}
        aria-label="Меню проекта"
        aria-haspopup="menu"
        aria-expanded={open}
        onKeyDown={onKeyDown}
      >
        <KebabIcon />
      </button>
      {open && (
        <div ref={menuRef} className="ds-menu ds-menu--end" role="menu" onKeyDown={onKeyDown}>
          {item("Открыть", onOpen)}
          {canShare && item("Доступ", onAccess)}
          {isOwner && item("Редактировать", onEdit)}
          {isOwner && (archivedTab ? (
            <>
              {item("Восстановить", onRestore)}
              {item("Удалить навсегда", onDelete, true)}
            </>
          ) : (
            item("Архивировать", onArchive)
          ))}
        </div>
      )}
    </div>
  );
}

function fmtDate(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleDateString("ru-RU", { day: "numeric", month: "short" });
}
