// Пара действий над схемой в шапке: «Экспорт» и «Обновить из репозитория».
//
// Живёт отдельным компонентом, потому что шапок ДВЕ и они не наследуются друг от
// друга: оболочка проекта (ProjectShell) и редактор-карта (MapEditorPage, свой
// роут мимо оболочки). Раньше кнопки были только в оболочке — в редакторе их
// просто не было (находка ручной проверки 2026-08-08), а копирование разметки
// гарантировало бы расхождение при первой же правке.
//
// Компонент владеет ОБЕИМИ модалками и тостом итога: страницам остаётся сказать,
// что экспортировать, и перечитать данные после применения синка.
import { useEffect, useRef, useState } from "react";
import type { CSSProperties } from "react";
import ExportModal from "./ExportModal";
import SyncRepoModal from "./docsImport/SyncRepoModal";
import { ExportIcon, RepoSyncIcon } from "../ui/icons";

/** Область экспорта: что грузим и как назвать окно. */
export interface ExportScope {
  /** Ключ области ("all" / id узла / "proc:id") — по нему модалка перезапрашивает документ. */
  key: string;
  title: string;
  load: () => Promise<{ content: string }>;
}

interface Props {
  projectId: string;
  isArchitect: boolean;
  /** Что экспортировать в текущем состоянии страницы; null — экспортировать нечего. */
  exportScope: ExportScope | null;
  /** Подсказка кнопки экспорта (в режиме процессов она про Mermaid). */
  exportHint?: string;
  /** Спрятать синхронизацию целиком (режим процессов — обновлять там нечего). */
  syncHidden?: boolean;
  /** Синк записал схему — страница перечитывает данные. */
  onSynced: () => void;
  /** Размер кнопок: в оболочке 34, в редакторе 32 (там соседи меньше). */
  size?: number;
}

const TOAST_MS = 5000;

export default function SchemaActions({
  projectId,
  isArchitect,
  exportScope,
  exportHint = "Экспорт в YAML",
  syncHidden = false,
  onSynced,
  size = 34,
}: Props) {
  const [exportOpen, setExportOpen] = useState(false);
  const [syncOpen, setSyncOpen] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  const toastTimer = useRef<number | null>(null);

  useEffect(() => () => {
    if (toastTimer.current) window.clearTimeout(toastTimer.current);
  }, []);

  function showToast(message: string) {
    setToast(message);
    if (toastTimer.current) window.clearTimeout(toastTimer.current);
    toastTimer.current = window.setTimeout(() => setToast(null), TOAST_MS);
  }

  const btn: CSSProperties = { ...iconBtn, width: size, height: size };

  return (
    <>
      <button
        className="icon-btn"
        style={btn}
        onClick={() => setExportOpen(true)}
        disabled={!exportScope}
        title={exportHint}
        aria-label="Экспорт"
      >
        <ExportIcon />
      </button>
      {isArchitect && !syncHidden && (
        <button
          className="icon-btn"
          style={btn}
          onClick={() => setSyncOpen(true)}
          title="Обновить схему из репозитория"
          aria-label="Обновить из репозитория"
        >
          <RepoSyncIcon />
        </button>
      )}

      {exportOpen && exportScope && (
        <ExportModal
          title={exportScope.title}
          loadKey={exportScope.key}
          load={exportScope.load}
          onClose={() => setExportOpen(false)}
        />
      )}
      {syncOpen && (
        <SyncRepoModal
          projectId={projectId}
          onClose={() => setSyncOpen(false)}
          onApplied={(message) => {
            showToast(message);
            onSynced();
          }}
        />
      )}
      {toast && <div style={toastStyle}>{toast}</div>}
    </>
  );
}

// cursor ЗДЕСЬ НЕ ЗАДАЁМ: инлайн-стиль перебил бы not-allowed у неактивной кнопки
// экспорта. Курсор и состояние :disabled — глобальным CSS (index.css).
const iconBtn: CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
  flex: "none",
  background: "#fff",
  color: "#475569",
  border: "1px solid #e2e8f0",
  borderRadius: 8,
};
// Тост-итог применения синка: тот же язык, что у тостов конкурентности.
const toastStyle: CSSProperties = {
  position: "fixed",
  right: 18,
  bottom: 18,
  zIndex: 60,
  maxWidth: 420,
  padding: "10px 14px",
  borderRadius: 8,
  background: "#065f46",
  color: "#ecfdf5",
  fontSize: 13,
  lineHeight: 1.45,
  boxShadow: "0 10px 24px rgba(15,23,42,.18)",
};
