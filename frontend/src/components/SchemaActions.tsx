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
// Вид один в обеих шапках (редизайн, фазы 4б и 5): тихая кнопка-значок и меню нового
// языка (ui/ds.css). Редактор-карта ставит сверху пункты самой страницы (подписи связей,
// «Переразложить уровень»): отдельные кнопки им в шапке не нужны. Закрытие, стрелки и
// возврат фокуса на кнопку — общим хуком ui/useMenu.
import { useEffect, useRef, useState } from "react";
import type { CSSProperties } from "react";
import ExportModal from "./ExportModal";
import SyncRepoModal from "./docsImport/SyncRepoModal";
import ImportIntoModal from "./project/ImportIntoModal";
import { KebabIcon } from "../ui/icons";
import { useMenu } from "../ui/useMenu";
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
  /** Пункты страницы над общими, отделены чертой (шапка редактора-карты). */
  items?: readonly SchemaMenuItem[];
}

const TOAST_MS = 5000;

export default function SchemaActions({
  projectId,
  isArchitect,
  exportScope,
  syncHidden = false,
  onSynced,
  items = NO_ITEMS,
}: Props) {
  const [menuOpen, setMenuOpen] = useState(false);
  const [exportOpen, setExportOpen] = useState(false);
  const [syncOpen, setSyncOpen] = useState(false);
  const [importIntoOpen, setImportIntoOpen] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  const toastTimer = useRef<number | null>(null);
  const { wrapRef, triggerRef, menuRef, onKeyDown, pick } = useMenu(menuOpen, setMenuOpen);

  useEffect(() => () => {
    if (toastTimer.current) window.clearTimeout(toastTimer.current);
  }, []);

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

  return (
    <div ref={wrapRef} className="ds-menu-root">
      <button
        ref={triggerRef}
        type="button"
        className="ds-icon-btn"
        onClick={() => setMenuOpen((o) => !o)}
        title="Действия со схемой"
        aria-label="Действия со схемой"
        aria-haspopup="menu"
        aria-expanded={menuOpen}
        onKeyDown={onKeyDown}
      >
        <KebabIcon />
      </button>

      {menuOpen && (
        <div ref={menuRef} className="ds-menu ds-menu--end" style={menuWidth} role="menu" aria-label="Действия со схемой" onKeyDown={onKeyDown}>
          {items.length > 0 && (
            <>
              {items.map((it) => (
                <button
                  key={it.label}
                  type="button"
                  className="ds-menu-item"
                  role="menuitem"
                  disabled={it.disabled}
                  onClick={() => pick(it.onSelect)}
                >
                  {it.label}
                </button>
              ))}
              <div className="ds-menu-sep" role="separator" />
            </>
          )}
          <button
            type="button"
            className="ds-menu-item"
            role="menuitem"
            disabled={!exportScope}
            onClick={() => pick(() => setExportOpen(true))}
          >
            {exportScope?.title ?? "Экспорт"}
          </button>
          {isArchitect && !syncHidden && (
            <button
              type="button"
              className="ds-menu-item"
              role="menuitem"
              title="Изменения из файлов сольются с текущей схемой"
              onClick={() => pick(() => setSyncOpen(true))}
            >
              Обновить из кода
            </button>
          )}
          {exportScope?.archive && (
            <button
              type="button"
              className="ds-menu-item"
              role="menuitem"
              disabled={archiveBusy}
              title="Архив всего, что есть в проекте: схема, схемы логики, спецификации, структуры баз, каналы брокеров, конфигурация и процессы"
              onClick={() => pick(() => { void downloadArchive(); })}
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
              className="ds-menu-item"
              role="menuitem"
              title="Добавить к проекту всё, что есть в архивах других проектов"
              onClick={() => pick(() => setImportIntoOpen(true))}
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
      {/* Тост итога и отказа: низ окна справа (ui/ds.css). */}
      {toast && <div className="ds-toast ds-toast--bottom-end">{toast}</div>}
    </div>
  );
}

const NO_ITEMS: readonly SchemaMenuItem[] = [];

// Меню не уже 240px: короткие пункты оболочки («Экспорт схемы») не сужают его.
const menuWidth: CSSProperties = { minWidth: 240 };
