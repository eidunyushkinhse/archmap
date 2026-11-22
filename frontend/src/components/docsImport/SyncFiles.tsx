// «Ответы агента» в окне «Обновить из кода»: зона файлов, принесённые файлы и вставка
// текстом. Зона — тихая пунктирная рамка: строка о том, что сюда класть, и две текстовые
// кнопки. Клик по самой зоне открывает выбор файлов, как раньше; файлы принимает всё
// окно (перетаскивание — useSyncImport, подсветка — over). Под зоной имена файлов с
// крестиком; длинное имя обрезается, целиком — в подсказке.
//
// Вставка текстом — запись «вставка-N» с полем: поле показывает выбранную вставку или
// последнюю из них. Запись с диска своего поля не имеет: её имя без расширения
// невозможно (выбор и перетаскивание принимают только .yaml, .yml и .txt).
import { useRef } from "react";
import type { DocsFile } from "../../types";
import { noAutofill } from "../../ui/noAutofill";
import { MAX_FILES } from "./useDocsFiles";
import type { DocsFilesApi } from "./useDocsFiles";
import { SYNC_ACCEPT } from "./useSyncImport";
import "../../ui/ds.css";
import "./syncRepo.css";

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
  const input = useRef<HTMLInputElement>(null);
  const full = pkg.files.length >= MAX_FILES;
  const pick = () => { if (!full) input.current?.click(); };
  const paste = shownPaste(pkg.files, pkg.active);

  return (
    <>
      <div className={"sync-drop" + (over ? " is-over" : "") + (full ? " is-full" : "")} onClick={pick}>
        <p className="sync-drop-text">Перетащите сюда файлы YAML, по одному на репозиторий</p>
        <div className="sync-drop-acts">
          <button type="button" className="ds-add" disabled={full} onClick={(e) => { e.stopPropagation(); pick(); }}>
            Выбрать файлы
          </button>
          <button type="button" className="ds-add" disabled={full} onClick={(e) => { e.stopPropagation(); pkg.addPaste(); }}>
            Вставить текст
          </button>
        </div>
      </div>
      <input
        ref={input}
        type="file"
        multiple
        accept={SYNC_ACCEPT.join(",")}
        hidden
        onChange={(e) => {
          pkg.pickFiles(e.target.files);
          e.target.value = ""; // тот же файл можно выбрать ещё раз
        }}
      />
      {dropError && <p className="ds-warn sync-line">{dropError}</p>}
      {pkg.sizeError && <p className="ds-danger sync-line">{pkg.sizeError}</p>}

      {pkg.files.length > 0 && (
        <ul className="sync-files" aria-label="Файлы">
          {pkg.files.map((f, i) => (
            <li key={f.name} className="sync-file">
              {isPaste(f) ? (
                <button
                  type="button"
                  className={"sync-file-name" + (i === paste ? " is-active" : "")}
                  aria-pressed={i === paste}
                  title={f.name}
                  onClick={() => pkg.setActive(i)}
                >
                  {f.name}
                </button>
              ) : (
                <span className="sync-file-name" title={f.name}>{f.name}</span>
              )}
              <button type="button" className="ds-del" aria-label={`Убрать ${f.name}`} title="Убрать" onClick={() => pkg.removeFile(i)}>
                ×
              </button>
            </li>
          ))}
        </ul>
      )}

      {paste >= 0 && (
        <textarea
          {...noAutofill("sync-repo-paste")}
          className="sync-paste"
          aria-label={`Текст ${pkg.files[paste].name}`}
          value={pkg.files[paste].content}
          onChange={(e) => pkg.setText(paste, e.target.value)}
          placeholder="Вставьте сюда YAML от агента"
          spellCheck={false}
        />
      )}
    </>
  );
}
