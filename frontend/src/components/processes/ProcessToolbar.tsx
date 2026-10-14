// Тулбар над диаграммой процесса: имя и область, «Восстановить связи», палитра
// фрагментов, «+ Участник», Undo/Redo, вид схемы и тумблер «Редактировать/Готово».
// Вынесено из ProcessCanvas (аудит F-2) — только разметка, состояние у холста.
import type { CSSProperties } from "react";
import type { FragmentKind } from "../../types";
import { RedoIcon, UndoIcon } from "../../ui/icons";
import { IcoEdit, IcoPlus } from "./icons";
import { SchemaViewSeg } from "./SchemaViewChrome";
import { BPT, BROKEN } from "./tokens";
import type { SchemaView } from "../schemaView";

const FRAGMENTS: FragmentKind[] = ["alt", "opt", "loop", "par"];

interface Props {
  name: string;
  scopeName: string;
  isArchitect: boolean;
  editing: boolean;
  onToggleEditing: (next: boolean) => void;
  // Повисшие шаги, которые «Восстановить связи» может починить; 0 — кнопки нет.
  danglingCount: number;
  onReattach: () => void;
  // Выбранный вид фрагмента для протягивания диапазона (повторный клик снимает).
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
}

export default function ProcessToolbar({
  name, scopeName, isArchitect, editing, onToggleEditing, danglingCount, onReattach,
  fragSelect, onFragSelect, canFragment, onAddParticipant, history, hasStatus, view, onViewChange,
}: Props) {
  return (
    <div style={toolbarRow} className="bp">
      <b style={{ fontSize: 15, color: BPT.head }}>{name}</b>
      <span style={scopeChip}>область: {scopeName}</span>
      <div style={{ marginLeft: "auto", display: "flex", alignItems: "center", gap: 8 }}>
        {editing && danglingCount > 0 && (
          <>
            <button
              className="bp-btn-ghost"
              style={{ height: 26, padding: "0 10px", color: BROKEN.ink, borderColor: BROKEN.border }}
              title="Найти связи схемы для шагов без связи (например, после правки схемы)"
              onClick={onReattach}
            >
              Восстановить связи ({danglingCount})
            </button>
            <span style={divider} />
          </>
        )}
        {editing && (
          <>
            <span style={{ fontSize: 11, color: BPT.mut }}>Фрагмент:</span>
            <div style={{ display: "inline-flex", alignItems: "center", gap: 5 }}>
              {FRAGMENTS.map((k) => (
                <button
                  key={k}
                  className={"bp-palitem" + (fragSelect === k ? " is-active" : "")}
                  title={`Фрагмент ${k} — выделить диапазон сообщений`}
                  onClick={() => onFragSelect(k)}
                  disabled={!canFragment}
                >
                  <span className="bp-fragtag">{k}</span>
                </button>
              ))}
            </div>
            <span style={divider} />
            <button className="bp-addpart" onClick={onAddParticipant}>
              <IcoPlus s={14} />
              <span>Участник</span>
            </button>
            <span style={divider} />
            <div style={{ display: "inline-flex", gap: 4 }}>
              <button className="bp-iconbtn" onClick={history.undo} disabled={!history.canUndo || history.busy} title="Отменить · Ctrl+Z" aria-label="Отменить">
                <UndoIcon size={16} />
              </button>
              <button className="bp-iconbtn" onClick={history.redo} disabled={!history.canRedo || history.busy} title="Вернуть · Ctrl+Shift+Z" aria-label="Вернуть">
                <RedoIcon size={16} />
              </button>
            </div>
            <span style={{ fontSize: 12, color: "#0e9f6e", display: "inline-flex", alignItems: "center", gap: 5 }}>
              <span style={{ width: 7, height: 7, borderRadius: 4, background: "#0e9f6e" }} />
              сохранено
            </span>
          </>
        )}
        {hasStatus && <SchemaViewSeg view={view} onChange={onViewChange} />}
        {isArchitect && (
          <button
            className="bp-btn-ghost"
            style={editing ? { background: BPT.wash, borderColor: "#bfdbfe", color: BPT.accent } : undefined}
            onClick={() => onToggleEditing(!editing)}
          >
            {editing ? <IcoCheck s={15} /> : <IcoEdit s={14} />}
            <span style={{ marginLeft: 6 }}>{editing ? "Готово" : "Редактировать"}</span>
          </button>
        )}
      </div>
    </div>
  );
}

// Глиф «галочка» для тумблера «Готово». Тоньше CheckIcon из ui/icons (тот — для мелких
// статусов 12–14 px), в пару к соседней IcoEdit.
function IcoCheck({ s = 15 }: { s?: number }) {
  return (
    <svg width={s} height={s} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.9} strokeLinecap="round" strokeLinejoin="round">
      <path d="M5 12 L10 17 L19 7" />
    </svg>
  );
}

const toolbarRow: CSSProperties = {
  height: 50,
  flex: "none",
  display: "flex",
  alignItems: "center",
  gap: 10,
  padding: "0 18px",
  borderBottom: "1px solid " + BPT.line,
  background: "#fff",
};
const scopeChip: CSSProperties = {
  fontSize: 11,
  fontWeight: 600,
  color: BPT.micro,
  background: "#f1f5f9",
  borderRadius: 6,
  padding: "3px 9px",
};
const divider: CSSProperties = { width: 1, height: 22, background: BPT.line, margin: "0 3px" };
