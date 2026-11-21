// Меню «Действия со схемой» в шапке: кебаб (три точки) с пунктами СЛОВАМИ,
// сетка 2×2 (имена — приёмка 2026-09-02, ревизия текстов 2026-11-02, Р1 и Р2):
// «Экспорт схемы» / «Обновить из кода» (синк из репозитория) про YAML-схему,
// «Экспорт проекта (zip)» / «Догрузить архив» про архив знания целиком.
// «Догрузить архив» — догрузка архива (или нескольких) другого проекта к текущему
// с мерджем: живой пункт с Ф4 эпика «единый импорт». Прежде были две пиктограммы, а архив прятался
// кнопкой в модалке экспорта — непонятно, что скачается архив ВСЕГО проекта.
//
// Живёт отдельным компонентом, потому что шапок ДВЕ и они не наследуются друг от
// друга: оболочка проекта (ProjectShell) и редактор-карта (MapEditorPage, свой
// роут мимо оболочки). Раньше кнопки были только в оболочке — в редакторе их
// просто не было (находка ручной проверки 2026-08-08), а копирование разметки
// гарантировало бы расхождение при первой же правке.
//
// Компонент владеет ВСЕМИ тремя модалками, скачиванием архива и тостом итога:
// страницам остаётся сказать, что экспортировать, и перечитать данные после того,
// как схему изменил синк или догрузка архива.
//
// В шапке редактора-карты (placement "editor", редизайн, фаза 4б) кнопка — тихая
// кнопка-значок, меню — нового языка (ui/ds.css), а сверху стоят пункты самой страницы
// (подписи связей, «Переразложить уровень»): отдельные кнопки им в шапке не нужны. В
// оболочке проекта меню прежнее.
import { useEffect, useRef, useState } from "react";
import type { CSSProperties } from "react";
import ExportModal from "./ExportModal";
import SyncRepoModal from "./docsImport/SyncRepoModal";
import ImportIntoModal from "./project/ImportIntoModal";
import { KebabIcon } from "../ui/icons";
import { useDismiss } from "../ui/useDismiss";
import "../ui/ds.css";

/** Область экспорта: что грузим и как назвать окно/пункт меню. */
export interface ExportScope {
  /** Ключ области ("all" / id узла / "proc:id") — по нему модалка перезапрашивает документ. */
  key: string;
  title: string;
  load: () => Promise<{ content: string }>;
  /** Полный архив знания (zip) — только у скоупа «вся схема». */
  archive?: { filename: string; load: () => Promise<Blob> };
}

/** Пункт меню от страницы: действие над открытой схемой (редактор-карта). */
export interface SchemaMenuItem {
  label: string;
  onSelect: () => void;
  disabled?: boolean;
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
  /** Где стоит меню: шапка оболочки (кнопка в рамке 34px, меню прежнего вида) или шапка
   *  редактора-карты (тихая кнопка-значок и меню нового языка). */
  placement?: "header" | "editor";
  /** Пункты страницы над общими, отделены чертой (только в шапке редактора). */
  items?: readonly SchemaMenuItem[];
}

const TOAST_MS = 5000;

export default function SchemaActions({
  projectId,
  isArchitect,
  exportScope,
  syncHidden = false,
  onSynced,
  placement = "header",
  items = NO_ITEMS,
}: Props) {
  const [menuOpen, setMenuOpen] = useState(false);
  const [exportOpen, setExportOpen] = useState(false);
  const [syncOpen, setSyncOpen] = useState(false);
  const [importIntoOpen, setImportIntoOpen] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  const toastTimer = useRef<number | null>(null);
  const wrapRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => () => {
    if (toastTimer.current) window.clearTimeout(toastTimer.current);
  }, []);

  useDismiss(menuOpen, wrapRef, setMenuOpen);

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
      showToast("Не удалось собрать архив. Попробуйте ещё раз.");
    } finally {
      setArchiveBusy(false);
    }
  };

  // Вид кнопки и пунктов по месту: в редакторе — классы нового языка без инлайна.
  const editor = placement === "editor";
  const item = editor
    ? { className: "ds-menu-item" }
    : { className: "sam-item", style: menuItem };

  return (
    <div ref={wrapRef} style={{ position: "relative" }}>
      <button
        type="button"
        className={editor ? "ds-icon-btn" : "icon-btn"}
        style={editor ? undefined : iconBtn}
        onClick={() => setMenuOpen((o) => !o)}
        title="Действия со схемой"
        aria-label="Действия со схемой"
        aria-haspopup="menu"
        aria-expanded={menuOpen}
      >
        <KebabIcon />
      </button>

      {menuOpen && (
        <div
          className={editor ? "ds-menu" : undefined}
          style={editor ? editorMenu : menu}
          role="menu"
          aria-label="Действия со схемой"
        >
          {editor && items.length > 0 && (
            <>
              {items.map((it) => (
                <button
                  key={it.label}
                  type="button"
                  {...item}
                  role="menuitem"
                  disabled={it.disabled}
                  onClick={() => { setMenuOpen(false); it.onSelect(); }}
                >
                  {it.label}
                </button>
              ))}
              <div className="ds-menu-sep" role="separator" />
            </>
          )}
          <button
            type="button"
            {...item}
            role="menuitem"
            disabled={!exportScope}
            onClick={() => { setMenuOpen(false); setExportOpen(true); }}
          >
            {exportScope?.title ?? "Экспорт"}
          </button>
          {isArchitect && !syncHidden && (
            <button
              type="button"
              {...item}
              role="menuitem"
              title="Изменения из файлов сольются с текущей схемой"
              onClick={() => { setMenuOpen(false); setSyncOpen(true); }}
            >
              Обновить из кода
            </button>
          )}
          {exportScope?.archive && (
            <button
              type="button"
              {...item}
              role="menuitem"
              disabled={archiveBusy}
              title="Архив всего, что есть в проекте: схема, схемы логики, спецификации, структуры баз, каналы брокеров, конфигурация и процессы"
              onClick={() => { setMenuOpen(false); void downloadArchive(); }}
            >
              {archiveBusy ? "Собираем архив" : "Экспорт проекта (zip)"}
            </button>
          )}
          {isArchitect && exportScope?.archive && (
            // Зеркало «Экспорта проекта»: архив, скачанный там, здесь доливается к
            // другому проекту. Мердж аддитивен — живое знание перетирается только
            // явным выбором в превью (Ф4 эпика «единый импорт»).
            <button
              type="button"
              {...item}
              role="menuitem"
              title="Добавить к проекту всё, что есть в архивах других проектов"
              onClick={() => { setMenuOpen(false); setImportIntoOpen(true); }}
            >
              Догрузить архив
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
      {importIntoOpen && (
        <ImportIntoModal
          projectId={projectId}
          onClose={() => setImportIntoOpen(false)}
          onApplied={(message) => {
            showToast(message);
            // Схема изменилась — тот же канал ресинка, что у «Обновить из кода».
            onSynced();
          }}
        />
      )}
      {/* Тост остаётся прежнего вида и в шапке нового языка (legacy-root, ui/tokens.css). */}
      {toast && <div className="legacy-root" style={toastStyle}>{toast}</div>}
    </div>
  );
}

const NO_ITEMS: readonly SchemaMenuItem[] = [];

// cursor ЗДЕСЬ НЕ ЗАДАЁМ: инлайн-стиль перебил бы not-allowed у неактивной кнопки
// (курсор и :disabled — глобальным CSS, index.css). Ховеры пунктов — chrome.css (.sam-item).
const iconBtn: CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
  flex: "none",
  width: 34,
  height: 34,
  background: "#fff",
  color: "#475569",
  border: "1px solid #e2e8f0",
  borderRadius: 8,
};
// Меню нового языка (ds-menu) — под кнопкой у правого края; остальное задаёт класс.
// Ширина по самому длинному пункту: у меню без левого края доступная ширина — ширина
// кнопки, и пункты переносились бы.
const editorMenu: CSSProperties = { top: "calc(100% + 4px)", right: 0, width: "max-content", minWidth: 240 };
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
  // Фон — в .sam-item (chrome.css): инлайновый background перебивал бы :hover.
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
