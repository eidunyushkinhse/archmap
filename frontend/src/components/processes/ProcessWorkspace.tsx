// Воркспейс режима «Процессы» — композиция рейла (список процессов) и холста
// (диаграмма выбранного). Владеет списком processesApi.list(), выбором, флагами
// railOpen/editing (персист в localStorage) и операциями новый/дублировать/удалить.
// Вынесен из TreePage, чтобы не раздувать и без того большой компонент страницы.
import { useCallback, useEffect, useRef, useState } from "react";
import type { CSSProperties } from "react";
import { processesApi } from "../../api/processes";
import type { ProcessListItem } from "../../types";
import ProcessCanvas from "./ProcessCanvas";
import ProcessImportModal from "./ProcessImportModal";
import ProcessRail from "./ProcessRail";
import { IcoFlow } from "./icons";
import { BPT } from "./tokens";
import "./processes.css";

interface Props {
  isArchitect: boolean;
  // Стартовый выбор процесса (клик по процессу на странице узла). Применяется
  // только при маунте (воркспейс монтируется на входе в режим «Процессы»).
  initialProcessId?: string;
  // Уведомление родителя (ProjectShell) о выбранном процессе — чтобы кнопка экспорта
  // в шапке знала, какой процесс выгружать в Mermaid. null = ничего не выбрано.
  onSelectedChange?: (sel: { id: string; name: string } | null) => void;
  // Процесс изменили (любая мутация канваса). Оболочке это нужно, чтобы освежить
  // знак «Незавершённость схемы»: класс «Сообщения без связи» считается по
  // сообщениям, а они живут здесь — без сигнала знак висел бы протухшим
  // (находка 2026-08-10).
  onChanged?: () => void;
}

const LS_KEY = "bp_workspace_v1";
interface Prefs {
  railOpen?: boolean;
  editing?: boolean;
}
function readPrefs(): Prefs {
  try {
    return JSON.parse(localStorage.getItem(LS_KEY) ?? "{}") as Prefs;
  } catch {
    return {};
  }
}

export default function ProcessWorkspace({
  isArchitect, initialProcessId, onSelectedChange, onChanged,
}: Props) {
  const [items, setItems] = useState<ProcessListItem[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Явно выбранный процесс. null → берём первый из списка (derived ниже), без эффекта.
  const [picked, setPicked] = useState<string | null>(initialProcessId ?? null);
  // Импорт из mermaid: заводит НОВЫЙ процесс (слияние с существующим — отдельная задача).
  const [importing, setImporting] = useState(false);
  const [railOpen, setRailOpen] = useState<boolean>(() => readPrefs().railOpen ?? true);
  const [editingPref, setEditingPref] = useState<boolean>(() => readPrefs().editing ?? false);

  useEffect(() => {
    localStorage.setItem(LS_KEY, JSON.stringify({ railOpen, editing: editingPref }));
  }, [railOpen, editingPref]);

  const reload = useCallback(() => {
    return processesApi
      .list()
      .then((list) => { setItems(list); return list; })
      .catch((e: unknown) => { setError(e instanceof Error ? e.message : "Не удалось загрузить процессы"); return null; });
  }, []);

  // eslint-disable-next-line react-hooks/exhaustive-deps -- первичная загрузка при маунте
  useEffect(() => { void reload(); }, []);

  // Выбранный = явный (если ещё в списке) либо первый. Производное — без эффекта-зеркала.
  const selectedId = (picked && items?.some((p) => p.id === picked) ? picked : items?.[0]?.id) ?? null;
  // Правка только архитектору; зрителю холст read-only.
  const editing = isArchitect && editingPref;

  // Сообщаем родителю выбранный процесс (id + имя) — для кнопки экспорта в шапке.
  // Колбэк держим в ref (пересоздаётся родителем на рендер), эффект зависит только
  // от самого выбора, а не от идентичности колбэка.
  const selectedItem = items?.find((p) => p.id === selectedId) ?? null;
  const selName = selectedItem?.name ?? null;
  const notifyRef = useRef(onSelectedChange);
  useEffect(() => { notifyRef.current = onSelectedChange; });
  useEffect(() => {
    notifyRef.current?.(selectedId ? { id: selectedId, name: selName ?? "" } : null);
  }, [selectedId, selName]);

  // Защита от гонок: held токен последней операции, чтобы не перетереть выбор.
  const opSeq = useRef(0);

  async function onNew() {
    const myOp = ++opSeq.current;
    try {
      const created = await processesApi.create({ name: "Новый процесс" });
      await reload();
      if (opSeq.current === myOp) {
        setPicked(created.id);
        setEditingPref(true); // новый процесс сразу в правке (как было в BusinessProcessSection)
      }
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : "Не удалось создать процесс");
    }
  }

  async function onDuplicate(id: string) {
    const myOp = ++opSeq.current;
    try {
      const copy = await processesApi.duplicate(id);
      await reload();
      if (opSeq.current === myOp) setPicked(copy.id);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : "Не удалось дублировать процесс");
    }
  }

  async function onDelete(id: string) {
    try {
      await processesApi.remove(id);
      // если снесли выбранный — сбрасываем явный выбор, derived возьмёт первый
      if (picked === id) setPicked(null);
      await reload();
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : "Не удалось удалить процесс");
    }
  }

  return (
    <div style={workspace}>
      {importing && (
        <ProcessImportModal
          onClose={() => setImporting(false)}
          onImported={(pid) => {
            setImporting(false);
            setPicked(pid);
            void reload();
            onChanged?.();  // импорт создал участников/шаги — знак алертов протух
          }}
        />
      )}
      <ProcessRail
        processes={items}
        selectedId={selectedId}
        onSelect={(id) => setPicked(id)}
        onNew={() => void onNew()}
        onImport={() => setImporting(true)}
        expanded={railOpen}
        onToggle={() => setRailOpen((o) => !o)}
        isArchitect={isArchitect}
        onDuplicate={(id) => void onDuplicate(id)}
        onDelete={(id) => void onDelete(id)}
      />
      {error && items === null ? (
        <div style={emptyWrap}>
          <div style={{ color: "#dc2626", fontSize: 13 }}>{error}</div>
        </div>
      ) : items !== null && items.length === 0 ? (
        <div style={emptyWrap}>
          <span style={emptyGlyph}>
            <IcoFlow s={26} />
          </span>
          <div style={{ fontSize: 15, fontWeight: 600, color: BPT.head }}>Пока ни одного процесса</div>
          <div style={{ fontSize: 13, color: BPT.mut, maxWidth: 360, textAlign: "center" }}>
            {isArchitect
              ? "Создайте процесс кнопкой «Новый процесс» в рейле слева — участники берутся из узлов схемы, сообщения из задокументированных связей."
              : "Архитектор ещё не создал ни одного бизнес-процесса."}
          </div>
        </div>
      ) : selectedId ? (
        <ProcessCanvas
          key={selectedId}
          id={selectedId}
          isArchitect={isArchitect}
          editing={editing}
          onToggleEditing={(v) => setEditingPref(v)}
          onChanged={() => { void reload(); onChanged?.(); }}
        />
      ) : (
        <div style={emptyWrap}>
          <div style={{ fontSize: 13, color: BPT.mut }}>Загрузка…</div>
        </div>
      )}
    </div>
  );
}

const workspace: CSSProperties = {
  flex: 1,
  display: "flex",
  minHeight: 0,
  minWidth: 0,
};
const emptyWrap: CSSProperties = {
  flex: 1,
  minWidth: 0,
  display: "flex",
  flexDirection: "column",
  alignItems: "center",
  justifyContent: "center",
  gap: 10,
  background: BPT.canvas,
};
const emptyGlyph: CSSProperties = {
  width: 52,
  height: 52,
  borderRadius: 14,
  background: "#fff",
  border: "1px solid " + BPT.line,
  color: BPT.accent,
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
  marginBottom: 4,
};
