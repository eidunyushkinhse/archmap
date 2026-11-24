// «Ответы агента» в окне «Обновить из кода»: общая зона файлов окон ввоза (FileZone) над
// пакетом файлов useDocsFiles. Здесь только то, что своё у этого окна: текст зоны, какие
// записи — вставки и какая из них в поле, строки отказа.
//
// Вставка текстом — запись «вставка-N» с полем: поле показывает выбранную вставку или
// последнюю из них. Запись с диска своего поля не имеет: её имя без расширения
// невозможно (выбор и перетаскивание принимают только .yaml, .yml и .txt).
import type { DocsFile } from "../../types";
import { MAX_FILES } from "./useDocsFiles";
import type { DocsFilesApi } from "./useDocsFiles";
import { SYNC_ACCEPT } from "./useSyncImport";
import FileZone from "./FileZone";

const isPaste = (f: DocsFile | undefined): boolean => !!f && !f.name.includes(".");

/** Какая вставка показана в поле: выбранная, иначе последняя; -1 — вставок нет. */
function shownPaste(files: DocsFile[], active: number): number {
  if (isPaste(files[active])) return active;
  for (let i = files.length - 1; i >= 0; i--) if (isPaste(files[i])) return i;
  return -1;
}

export default function SyncFiles({ pkg, over, dropError }: {
  pkg: DocsFilesApi;
  // Над окном тащат файлы: зона подсвечена.
  over: boolean;
  // Что из перетащенного не взято и почему.
  dropError: string | null;
}) {
  const paste = shownPaste(pkg.files, pkg.active);
  return (
    <FileZone
      text="Перетащите сюда файлы YAML, по одному на репозиторий"
      accept={SYNC_ACCEPT}
      over={over}
      full={pkg.files.length >= MAX_FILES}
      onFiles={pkg.pickFiles}
      onPaste={pkg.addPaste}
      files={pkg.files.map((f, i) => ({ key: f.name, name: f.name, openable: isPaste(f), active: i === paste }))}
      onOpen={pkg.setActive}
      onRemove={pkg.removeFile}
      editor={paste >= 0 ? {
        value: pkg.files[paste].content,
        onChange: (text) => pkg.setText(paste, text),
        label: `Текст ${pkg.files[paste].name}`,
        placeholder: "Вставьте сюда YAML от агента",
        autofill: "sync-repo-paste",
      } : null}
      notes={<>
        {dropError && <p className="ds-warn fz-line">{dropError}</p>}
        {pkg.sizeError && <p className="ds-danger fz-line">{pkg.sizeError}</p>}
      </>}
    />
  );
}
