// Рейл процессов (режим «Процессы») — портирован из прототипа варианта B (Rail),
// посажен на живые данные processesApi.list(). Развёрнутый ≈248px / свёрнутый ≈56px;
// шеврон сворачивания — всегда внизу, один значок повёрнут в две стороны. Список,
// бейджи статусов и ···-меню переиспользуют визуальный язык BusinessProcessSection.
import { useEffect, useRef, useState } from "react";
import type { CSSProperties } from "react";
import type { ProcessListItem } from "../../types";
import { CollapseIcon } from "../../ui/icons";
import { IcoFlow, IcoPlus } from "./icons";
import { pillStyle, pluralMessages, processBadge } from "./processBadge";
import { BPT } from "./tokens";
import "./processes.css";

interface Props {
  processes: ProcessListItem[] | null;
  selectedId: string | null;
  onSelect: (id: string) => void;
  onNew: () => void;
  // Импорт процесса из текста mermaid — рядом с созданием: оба заводят новый процесс.
  onImport: () => void;
  expanded: boolean;
  onToggle: () => void;
  isArchitect: boolean;
  onDuplicate: (id: string) => void;
  onDelete: (id: string) => void;
  // Переименование: двойной клик по имени открывает поле, Enter или уход из поля
  // сохраняют, Escape отменяет. Зовётся только с непустым и изменившимся именем.
  onRename: (id: string, name: string) => void;
}

export default function ProcessRail({
  processes,
  selectedId,
  onSelect,
  onNew,
  onImport,
  expanded,
  onToggle,
  isArchitect,
  onDuplicate,
  onDelete,
  onRename,
}: Props) {
  const [menuId, setMenuId] = useState<string | null>(null);
  const [confirmId, setConfirmId] = useState<string | null>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const [renaming, setRenaming] = useState<{ id: string; draft: string } | null>(null);
  // Enter закрывает поле, а снятое поле может прислать ещё и blur: второй раз не сохраняем.
  const renameClosed = useRef(false);

  function startRename(p: ProcessListItem) {
    renameClosed.current = false;
    setMenuId(null);
    setRenaming({ id: p.id, draft: p.name });
  }

  function finishRename(save: boolean) {
    if (renameClosed.current || !renaming) return;
    renameClosed.current = true;
    setRenaming(null);
    const name = renaming.draft.trim();
    const old = processes?.find((p) => p.id === renaming.id)?.name;
    if (save && name && name !== old) onRename(renaming.id, name);
  }

  // Клик мимо открытого меню — закрыть.
  useEffect(() => {
    if (!menuId) return;
    const h = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setMenuId(null);
        setConfirmId(null);
      }
    };
    document.addEventListener("mousedown", h);
    return () => document.removeEventListener("mousedown", h);
  }, [menuId]);

  if (!expanded) {
    return (
      <aside style={railCollapsed}>
        <button onClick={onNew} title="Новый процесс" style={collapsedPlus} disabled={!isArchitect}>
          <IcoPlus s={16} />
        </button>
        <button onClick={onToggle} title="Развернуть список процессов" style={{ ...railToggle, marginTop: "auto" }}>
          <CollapseIcon size={15} dir="right" />
        </button>
      </aside>
    );
  }

  return (
    <aside style={railExpanded}>
      <div style={railHead}>
        <span style={railTitle}>Процессы</span>
        <span style={{ marginLeft: "auto", fontSize: 11, color: BPT.mut }}>{processes?.length ?? ""}</span>
      </div>
      {isArchitect && (
        <div style={{ padding: "0 10px 10px", display: "flex", flexDirection: "column", gap: 6 }}>
          <button onClick={onNew} className="bp-newproc">
            <IcoPlus s={15} />
            <span>Новый процесс</span>
          </button>
          <button onClick={onImport} className="bp-btn-ghost" style={{ height: 28, fontSize: 12 }}>
            Импорт из Mermaid
          </button>
        </div>
      )}

      <div style={railList}>
        {processes === null ? (
          <div style={railHint}>Загрузка…</div>
        ) : processes.length === 0 ? (
          <div style={railHint}>Пока нет процессов</div>
        ) : (
          processes.map((p) => {
            const active = p.id === selectedId;
            const badge = processBadge(p.statuses);
            return (
              <div
                key={p.id}
                className={"bp-procrow" + (active ? " is-active" : "")}
                onClick={() => onSelect(p.id)}
                role="button"
                tabIndex={0}
              >
                <span className="bp-procglyph">
                  <IcoFlow s={15} />
                </span>
                <span className="bp-proctext">
                  <span style={{ display: "flex", alignItems: "center", gap: 6, minWidth: 0 }}>
                    {renaming?.id === p.id ? (
                      <input
                        className="bp-procname-input"
                        value={renaming.draft}
                        maxLength={256}
                        autoFocus
                        aria-label="Имя процесса"
                        // Выделяем всё и показываем начало: браузер прокручивает поле к концу
                        // выделения, и у длинного имени пряталась первая буква.
                        onFocus={(e) => {
                          const el = e.currentTarget;
                          el.select();
                          requestAnimationFrame(() => { el.scrollLeft = 0; });
                        }}
                        onChange={(e) => setRenaming({ id: p.id, draft: e.target.value })}
                        onKeyDown={(e) => {
                          if (e.key === "Enter") { e.preventDefault(); finishRename(true); }
                          if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); finishRename(false); }
                        }}
                        onBlur={() => finishRename(true)}
                        onClick={(e) => e.stopPropagation()}
                        onDoubleClick={(e) => e.stopPropagation()}
                      />
                    ) : (
                      <span
                        className="bp-procname"
                        style={{ minWidth: 0 }}
                        onDoubleClick={isArchitect ? (e) => { e.stopPropagation(); startRename(p); } : undefined}
                      >
                        {p.name}
                      </span>
                    )}
                    {badge && <span style={pillStyle(badge.tone)}>{badge.t}</span>}
                  </span>
                  <span className="bp-procsub">
                    {p.message_count} {pluralMessages(p.message_count)} · {p.scope_name ?? "Вся схема"}
                  </span>
                </span>
                {isArchitect && renaming?.id !== p.id && (
                  <button
                    className="bp-procdots"
                    title="Действия"
                    onClick={(e) => {
                      e.stopPropagation();
                      setConfirmId(null);
                      setMenuId((cur) => (cur === p.id ? null : p.id));
                    }}
                  >
                    <Dots />
                  </button>
                )}
                {menuId === p.id && (
                  <div ref={menuRef} className="bp-procmenu" onClick={(e) => e.stopPropagation()}>
                    <button
                      className="bp-menuitem"
                      onClick={() => { setMenuId(null); onDuplicate(p.id); }}
                    >
                      Дублировать
                    </button>
                    {confirmId === p.id ? (
                      <button
                        className="bp-menuitem bp-menuitem--danger"
                        onClick={() => { setMenuId(null); setConfirmId(null); onDelete(p.id); }}
                      >
                        Точно удалить?
                      </button>
                    ) : (
                      <button
                        className="bp-menuitem bp-menuitem--danger"
                        onClick={() => setConfirmId(p.id)}
                      >
                        Удалить
                      </button>
                    )}
                  </div>
                )}
              </div>
            );
          })
        )}
      </div>

      <button onClick={onToggle} title="Свернуть в рейл" style={{ ...railToggle, alignSelf: "flex-end", margin: "4px 12px 10px 0" }}>
        <CollapseIcon size={15} dir="left" />
      </button>
    </aside>
  );
}

// Три точки — как .bp-procdots в BusinessProcessSection (тот же глиф IcoDots, но он
// принимает s; здесь рисуем напрямую, чтобы не тянуть лишнего).
function Dots() {
  return (
    <svg width={15} height={15} viewBox="0 0 24 24" fill="currentColor">
      <circle cx="5" cy="12" r="1.6" />
      <circle cx="12" cy="12" r="1.6" />
      <circle cx="19" cy="12" r="1.6" />
    </svg>
  );
}

const railExpanded: CSSProperties = {
  width: 248,
  flex: "none",
  display: "flex",
  flexDirection: "column",
  background: BPT.panelBg,
  borderRight: "1px solid " + BPT.line,
};
const railCollapsed: CSSProperties = {
  width: 56,
  flex: "none",
  display: "flex",
  flexDirection: "column",
  alignItems: "center",
  gap: 8,
  padding: "12px 0",
  background: BPT.panelBg,
  borderRight: "1px solid " + BPT.line,
};
const railHead: CSSProperties = { display: "flex", alignItems: "center", padding: "13px 12px 10px" };
const railTitle: CSSProperties = {
  fontSize: 11,
  fontWeight: 700,
  letterSpacing: ".08em",
  textTransform: "uppercase",
  color: BPT.micro,
};
const railList: CSSProperties = {
  flex: 1,
  overflow: "auto",
  padding: "0 8px 8px",
  display: "flex",
  flexDirection: "column",
  gap: 2,
};
const railHint: CSSProperties = { fontSize: 12.5, color: BPT.mut, padding: "10px 6px" };
const railToggle: CSSProperties = {
  width: 34,
  height: 34,
  borderRadius: 8,
  border: "none",
  background: "transparent",
  color: BPT.mut,
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
  cursor: "pointer",
};
const collapsedPlus: CSSProperties = {
  width: 34,
  height: 34,
  borderRadius: 8,
  border: "1px dashed #93c5fd",
  background: BPT.wash,
  color: BPT.accent,
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
  cursor: "pointer",
};
