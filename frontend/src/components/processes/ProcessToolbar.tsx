// Шапка процесса над диаграммой (редизайн, фаза 3а): одна строка. Слева название
// (16px/600; редактору — поле в виде текста, как имя на странице объекта), справа
// переключатель вида и масштаба, инструменты правки и «Редактировать» / «Готово».
// Область процесса, если она не вся схема, — подсказкой у названия. Пока всё хорошо,
// шапка молчит: надписи «сохранено» нет, сбой записи показывает холст.
// Вынесено из ProcessCanvas (аудит F-2) — только разметка, состояние у холста.
import { useRef, useState } from "react";
import type { CSSProperties } from "react";
import type { FragmentKind } from "../../types";
import { ChevronDownIcon, PlusIcon, RedoIcon, UndoIcon } from "../../ui/icons";
import { noAutofill } from "../../ui/noAutofill";
import { SchemaViewSeg } from "./SchemaViewChrome";
import type { SchemaView } from "../schemaView";
import "../../ui/ds.css";
import "./processes.css";

// Виды фрагмента словами: человек выбирает смысл, буквы Mermaid — в скобках.
const FRAGMENTS: { kind: FragmentKind; label: string }[] = [
  { kind: "alt", label: "Условие (alt)" },
  { kind: "opt", label: "Необязательно (opt)" },
  { kind: "loop", label: "Цикл (loop)" },
  { kind: "par", label: "Параллельно (par)" },
];

interface Props {
  name: string;
  // Область процесса; null — вся схема (тогда о ней не говорим).
  scopeName: string | null;
  isArchitect: boolean;
  editing: boolean;
  onToggleEditing: (next: boolean) => void;
  // Переименование процесса (только редактору): зовётся с непустым изменившимся именем.
  onRename?: (name: string) => void;
  // Повисшие шаги, которые «Восстановить связи» может починить; 0 — кнопки нет.
  danglingCount: number;
  onReattach: () => void;
  // Выбранный вид фрагмента для протягивания диапазона (повторный выбор снимает).
  fragSelect: FragmentKind | null;
  onFragSelect: (kind: FragmentKind) => void;
  // Фрагмент выделять не из чего — шагов нет.
  canFragment: boolean;
  onAddParticipant: () => void;
  history: { undo: () => void; redo: () => void; canUndo: boolean; canRedo: boolean; busy: boolean };
  // Переключатель вида — только когда в процессе есть переход (planned/deprecated).
  hasStatus: boolean;
  view: SchemaView;
  onViewChange: (view: SchemaView) => void;
  // Переключатель «Вписать / 100%»: только в чтении и только когда диаграмма шире окна.
  fit: { on: boolean; onChange: (on: boolean) => void } | null;
}

export default function ProcessToolbar({
  name, scopeName, isArchitect, editing, onToggleEditing, onRename, danglingCount, onReattach,
  fragSelect, onFragSelect, canFragment, onAddParticipant, history, hasStatus, view, onViewChange, fit,
}: Props) {
  const scopeHint = scopeName ? `Область: ${scopeName}` : undefined;
  return (
    <div className="proc-head">
      {isArchitect && onRename ? (
        // Ключ по имени: имя сменилось снаружи (рейл, чужая правка) — поле начинает с него.
        <NameField key={name} name={name} title={scopeHint} onRename={onRename} />
      ) : (
        <h1 className="proc-name" title={scopeHint}>{name}</h1>
      )}
      <div className="proc-head-acts">
        {editing && danglingCount > 0 && (
          <button
            type="button"
            className="ds-btn proc-reattach"
            title="Найти связи схемы для шагов без связи (например, после правки схемы)"
            onClick={onReattach}
          >
            Восстановить связи ({danglingCount})
          </button>
        )}
        {editing && (
          <>
            <button
              type="button"
              className="proc-iconbtn"
              onClick={history.undo}
              disabled={!history.canUndo || history.busy}
              title="Отменить (Ctrl+Z)"
              aria-label="Отменить"
            >
              <UndoIcon size={16} />
            </button>
            <button
              type="button"
              className="proc-iconbtn"
              onClick={history.redo}
              disabled={!history.canRedo || history.busy}
              title="Повторить (Ctrl+Shift+Z)"
              aria-label="Повторить"
            >
              <RedoIcon size={16} />
            </button>
            <button type="button" className="ds-add proc-head-add" onClick={onAddParticipant}>
              <PlusIcon size={12} />
              Добавить участника
            </button>
            <FragmentMenu selected={fragSelect} onSelect={onFragSelect} disabled={!canFragment} />
          </>
        )}
        {hasStatus && <SchemaViewSeg view={view} onChange={onViewChange} />}
        {fit && (
          <div className="ds-tabs" role="radiogroup" aria-label="Масштаб">
            <button type="button" role="radio" aria-checked={fit.on} className={"ds-tab" + (fit.on ? " is-active" : "")} onClick={() => fit.onChange(true)}>
              Вписать
            </button>
            <button type="button" role="radio" aria-checked={!fit.on} className={"ds-tab" + (fit.on ? "" : " is-active")} onClick={() => fit.onChange(false)}>
              100%
            </button>
          </div>
        )}
        {isArchitect && (
          <button
            type="button"
            className={editing ? "ds-btn ds-btn--primary" : "ds-btn"}
            onClick={() => onToggleEditing(!editing)}
          >
            {editing ? "Готово" : "Редактировать"}
          </button>
        )}
      </div>
    </div>
  );
}

// Название процесса у редактора: поле в виде текста, ширина по имени (невидимая копия
// в той же ячейке, приём имени страницы объекта). Запись по уходу с поля и по Enter,
// Escape возвращает прежнее имя; пустое и неизменённое имя не пишется.
function NameField({ name, title, onRename }: { name: string; title?: string; onRename: (name: string) => void }) {
  const [draft, setDraft] = useState(name);
  // Escape уводит фокус с отказом: уход с поля в этот раз не пишет.
  const discard = useRef(false);
  const commit = () => {
    if (discard.current) { discard.current = false; setDraft(name); return; }
    const next = draft.trim();
    if (next && next !== name) onRename(next);
    else setDraft(name);
  };
  return (
    <span className="proc-name-fit" data-value={draft} title={title}>
      <input
        {...noAutofill("process-name-1")}
        className="proc-name-input"
        aria-label="Название процесса"
        maxLength={256}
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === "Enter") e.currentTarget.blur();
          if (e.key === "Escape") {
            // Своё Escape: откат имени, а не закрытие панели шага.
            e.stopPropagation();
            discard.current = true;
            e.currentTarget.blur();
          }
        }}
      />
    </span>
  );
}

// «Фрагмент» одной кнопкой с меню из четырёх видов. Выбор вида включает протягивание
// диапазона по шагам (механика прежняя); пока оно включено, кнопка нажата, повторный
// выбор того же вида его снимает.
function FragmentMenu({ selected, onSelect, disabled }: {
  selected: FragmentKind | null;
  onSelect: (kind: FragmentKind) => void;
  disabled: boolean;
}) {
  const [open, setOpen] = useState(false);
  return (
    <span
      className="proc-menuwrap"
      onKeyDown={(e) => {
        if (open && e.key === "Escape") { e.stopPropagation(); setOpen(false); }
      }}
    >
      <button
        type="button"
        className={"ds-btn" + (selected ? " is-pressed" : "")}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-pressed={selected != null}
        disabled={disabled}
        onClick={() => setOpen((o) => !o)}
      >
        Фрагмент
        <span className="proc-chev" aria-hidden="true"><ChevronDownIcon /></span>
      </button>
      {open && (
        <>
          <div style={backdrop} onClick={() => setOpen(false)} />
          <ul className="ds-menu proc-menu" role="menu">
            {FRAGMENTS.map((f) => (
              <li key={f.kind}>
                <button
                  type="button"
                  role="menuitem"
                  className={"ds-menu-item" + (selected === f.kind ? " is-current" : "")}
                  onClick={() => { setOpen(false); onSelect(f.kind); }}
                >
                  {f.label}
                </button>
              </li>
            ))}
          </ul>
        </>
      )}
    </span>
  );
}

const backdrop: CSSProperties = { position: "fixed", inset: 0, zIndex: 19 };
