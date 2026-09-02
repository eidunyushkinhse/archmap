// Меню «Действия со схемой» в шапке: кебаб (три точки) с пунктами СЛОВАМИ —
// «Экспорт …», «Обновить из репозитория…», «Скачать архив проекта (.zip)».
// Прежде были две пиктограммы, а архив прятался кнопкой в модалке экспорта —
// приёмка 2026-09-02 (П1): непонятно, что скачается архив ВСЕГО проекта.
//
// Живёт отдельным компонентом, потому что шапок ДВЕ и они не наследуются друг от
// друга: оболочка проекта (ProjectShell) и редактор-карта (MapEditorPage, свой
// роут мимо оболочки). Раньше кнопки были только в оболочке — в редакторе их
// просто не было (находка ручной проверки 2026-08-08), а копирование разметки
// гарантировало бы расхождение при первой же правке.
//
// Компонент владеет ОБЕИМИ модалками, скачиванием архива и тостом итога:
// страницам остаётся сказать, что экспортировать, и перечитать данные после синка.
import { useEffect, useRef, useState } from "react";
import type { CSSProperties } from "react";
import ExportModal from "./ExportModal";
import SyncRepoModal from "./docsImport/SyncRepoModal";
import { KebabIcon } from "../ui/icons";

/** Область экспорта: что грузим и как назвать окно/пункт меню. */
export interface ExportScope {
  /** Ключ области ("all" / id узла / "proc:id") — по нему модалка перезапрашивает документ. */
  key: string;
  title: string;
  load: () => Promise<{ content: string }>;
  /** Полный архив знания (zip) — только у скоупа «вся схема». */
  archive?: { filename: string; load: () => Promise<Blob> };
}

interface Props {
  projectId: string;
  isArchitect: boolean;
  /** Что экспортировать в текущем состоянии страницы; null — пункт экспорта гаснет. */
  exportScope: ExportScope | null;
  /** Спрятать синхронизацию целиком (режим процессов — обновлять там нечего). */
  syncHidden?: boolean;
  /** Синк записал схему — страница перечитывает данные. */
  onSynced: () => void;
  /** Размер кнопки: в оболочке 34, в редакторе 32 (там соседи меньше). */
  size?: number;
}

const TOAST_MS = 5000;

export default function SchemaActions({
  projectId,
  isArchitect,
  exportScope,
  syncHidden = false,
  onSynced,
  size = 34,
}: Props) {
  const [menuOpen, setMenuOpen] = useState(false);
  const [exportOpen, setExportOpen] = useState(false);
  const [syncOpen, setSyncOpen] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  const toastTimer = useRef<number | null>(null);
  const wrapRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => () => {
    if (toastTimer.current) window.clearTimeout(toastTimer.current);
  }, []);

  // Закрытие меню по клику вне и по Escape (паттерн ProfileMenu).
  useEffect(() => {
    if (!menuOpen) return;
    const onDown = (e: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setMenuOpen(false);
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setMenuOpen(false); };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [menuOpen]);

  function showToast(message: string) {
    setToast(message);
    if (toastTimer.current) window.clearTimeout(toastTimer.current);
    toastTimer.current = window.setTimeout(() => setToast(null), TOAST_MS);
  }

  // Скачивание архива: фетч с авторизацией → blob → временная ссылка. Прямой
  // <a href> не годится — заголовок Authorization в него не вписать. Переехало
  // из модалки экспорта вместе с кнопкой (П1 приёмки).
  const [archiveBusy, setArchiveBusy] = useState(false);
  const downloadArchive = async () => {
    const archive = exportScope?.archive;
    if (!archive || archiveBusy) return;
    setArchiveBusy(true);
    try {
      const blob = await archive.load();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = archive.filename;
      a.click();
      URL.revokeObjectURL(url);
    } catch {
      showToast("Не удалось собрать архив — попробуйте ещё раз.");
    } finally {
      setArchiveBusy(false);
    }
  };

  const btn: CSSProperties = { ...iconBtn, width: size, height: size };

  return (
    <div ref={wrapRef} style={{ position: "relative" }}>
      <button
        className="icon-btn"
        style={btn}
        onClick={() => setMenuOpen((o) => !o)}
        title="Действия со схемой"
        aria-label="Действия со схемой"
        aria-haspopup="menu"
        aria-expanded={menuOpen}
      >
        <KebabIcon />
      </button>

      {menuOpen && (
        <div style={menu} role="menu" aria-label="Действия со схемой">
          <button
            className="sam-item"
            style={menuItem}
            role="menuitem"
            disabled={!exportScope}
            onClick={() => { setMenuOpen(false); setExportOpen(true); }}
          >
            {(exportScope?.title ?? "Экспорт") + "…"}
          </button>
          {isArchitect && !syncHidden && (
            <button
              className="sam-item"
              style={menuItem}
              role="menuitem"
              onClick={() => { setMenuOpen(false); setSyncOpen(true); }}
            >
              Обновить из репозитория…
            </button>
          )}
          {exportScope?.archive && (
            <button
              className="sam-item"
              style={menuItem}
              role="menuitem"
              disabled={archiveBusy}
              title="Полный архив знания проекта: C4, схемы логики, спеки, структуры, конфигурация, процессы"
              onClick={() => { setMenuOpen(false); void downloadArchive(); }}
            >
              {archiveBusy ? "Собираем архив…" : "Скачать архив проекта (.zip)"}
            </button>
          )}
        </div>
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
    </div>
  );
}

// cursor ЗДЕСЬ НЕ ЗАДАЁМ: инлайн-стиль перебил бы not-allowed у неактивной кнопки
// (курсор и :disabled — глобальным CSS, index.css). Ховеры пунктов — chrome.css (.sam-item).
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
const menu: CSSProperties = {
  position: "absolute",
  top: "calc(100% + 8px)",
  right: 0,
  width: 260,
  background: "#fff",
  border: "1px solid #e2e8f0",
  borderRadius: 12,
  boxShadow: "0 16px 40px rgba(15,23,42,.16)",
  padding: 6,
  zIndex: 20,
  display: "flex",
  flexDirection: "column",
  gap: 2,
};
const menuItem: CSSProperties = {
  display: "block",
  width: "100%",
  textAlign: "left",
  padding: "8px 10px",
  border: "none",
  background: "none",
  borderRadius: 8,
  fontSize: 13.5,
  color: "#1e293b",
  lineHeight: 1.35,
};
// Тост-итог применения синка / ошибки архива: тот же язык, что у тостов конкурентности.
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
