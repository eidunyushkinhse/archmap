// Список процессов слева (режим «Процессы»; редизайн, фаза 3а). Строка — одно название
// (до двух строк, дальше многоточие, полное имя в подсказке), активная выделена
// подложкой. Сверху одна тихая «Добавить» (только редактору) с меню «Импорт из Mermaid»
// и «Новый процесс». Новый процесс не создаётся сразу: в списке появляется строка с полем
// имени, Enter создаёт, Escape или уход с пустым полем отменяет. Меню строки —
// «Дублировать» и «Удалить». Список сворачивается в узкую полосу.
import { useEffect, useRef, useState } from "react";
import type { ProcessListItem } from "../../types";
import { CollapseIcon } from "../../ui/icons";
import { noAutofill } from "../../ui/noAutofill";
import AddDocsMenu from "../AddDocsMenu";
import "../../ui/ds.css";
import "./processes.css";

interface Props {
  processes: ProcessListItem[] | null;
  selectedId: string | null;
  onSelect: (id: string) => void;
  // Импорт процесса из текста Mermaid — рядом с созданием: оба заводят новый процесс.
  onImport: () => void;
  // Ввод имени нового процесса: строка с полем видна, пока creating; onCreate зовётся с
  // непустым именем, onCancelCreate — при отказе (Escape, уход с пустым полем).
  creating: boolean;
  onStartCreate: () => void;
  onCreate: (name: string) => void;
  onCancelCreate: () => void;
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
  onImport,
  creating,
  onStartCreate,
  onCreate,
  onCancelCreate,
  expanded,
  onToggle,
  isArchitect,
  onDuplicate,
  onDelete,
  onRename,
}: Props) {
  const [menuId, setMenuId] = useState<string | null>(null);
  const [confirmId, setConfirmId] = useState<string | null>(null);
  const menuRef = useRef<HTMLUListElement>(null);
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
      <aside className="pr-rail pr-rail--collapsed">
        <button type="button" className="pr-toggle" onClick={onToggle} title="Развернуть список процессов">
          <CollapseIcon size={15} dir="right" />
        </button>
      </aside>
    );
  }

  return (
    <aside className="pr-rail">
      {isArchitect && (
        <div className="pr-top">
          <AddDocsMenu
            groups={[[
              { label: "Импорт из Mermaid", onSelect: onImport },
              { label: "Новый процесс", onSelect: onStartCreate },
            ]]}
          />
        </div>
      )}

      <div className="pr-list">
        {isArchitect && creating && (
          <NewProcessRow onCreate={onCreate} onCancel={onCancelCreate} />
        )}
        {processes === null ? (
          <div className="pr-hint">Загрузка</div>
        ) : (
          processes.map((p) => {
            const active = p.id === selectedId;
            return (
              <div
                key={p.id}
                className={"pr-row" + (active ? " is-active" : "")}
                onClick={() => onSelect(p.id)}
                role="button"
                tabIndex={0}
                aria-current={active ? "true" : undefined}
              >
                {renaming?.id === p.id ? (
                  <input
                    {...noAutofill("process-rail-1")}
                    className="ds-input pr-input"
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
                    className="pr-name"
                    title={p.name}
                    onDoubleClick={isArchitect ? (e) => { e.stopPropagation(); startRename(p); } : undefined}
                  >
                    {p.name}
                  </span>
                )}
                {isArchitect && renaming?.id !== p.id && (
                  <button
                    type="button"
                    className="pr-dots"
                    title="Действия"
                    aria-haspopup="menu"
                    aria-expanded={menuId === p.id}
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
                  <ul ref={menuRef} className="ds-menu pr-menu" role="menu" onClick={(e) => e.stopPropagation()}>
                    <li>
                      <button
                        type="button"
                        role="menuitem"
                        className="ds-menu-item"
                        onClick={() => { setMenuId(null); onDuplicate(p.id); }}
                      >
                        Дублировать
                      </button>
                    </li>
                    <li>
                      {confirmId === p.id ? (
                        <button
                          type="button"
                          role="menuitem"
                          className="ds-menu-item ds-menu-item--danger"
                          onClick={() => { setMenuId(null); setConfirmId(null); onDelete(p.id); }}
                        >
                          Удалить процесс?
                        </button>
                      ) : (
                        <button
                          type="button"
                          role="menuitem"
                          className="ds-menu-item ds-menu-item--danger"
                          onClick={() => setConfirmId(p.id)}
                        >
                          Удалить
                        </button>
                      )}
                    </li>
                  </ul>
                )}
              </div>
            );
          })
        )}
      </div>

      <button type="button" className="pr-toggle pr-toggle--end" onClick={onToggle} title="Свернуть список процессов">
        <CollapseIcon size={15} dir="left" />
      </button>
    </aside>
  );
}

// Строка ввода имени нового процесса. До Enter в базе ничего нет. Enter с именем —
// создать; Escape или уход с пустым полем — отказаться; уход с введённым именем — тоже
// создать (как переименование: набранное не теряется молча).
function NewProcessRow({ onCreate, onCancel }: { onCreate: (name: string) => void; onCancel: () => void }) {
  const [draft, setDraft] = useState("");
  // Enter снимает строку, а снятое поле может прислать ещё и blur: решаем один раз.
  const done = useRef(false);
  const finish = (save: boolean) => {
    if (done.current) return;
    done.current = true;
    const name = draft.trim();
    if (save && name) onCreate(name);
    else onCancel();
  };
  return (
    <div className="pr-row pr-row--new">
      <input
        {...noAutofill("process-rail-2")}
        className="ds-input pr-input"
        value={draft}
        maxLength={256}
        autoFocus
        aria-label="Имя нового процесса"
        placeholder="Название процесса"
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") { e.preventDefault(); finish(true); }
          if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); finish(false); }
        }}
        onBlur={() => finish(true)}
      />
    </div>
  );
}

// Три точки меню строки.
function Dots() {
  return (
    <svg width={15} height={15} viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <circle cx="5" cy="12" r="1.6" />
      <circle cx="12" cy="12" r="1.6" />
      <circle cx="19" cy="12" r="1.6" />
    </svg>
  );
}
