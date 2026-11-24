// Зона файлов окон ввоза нового языка («Обновить из кода», «Новый проект» в режимах
// «Импорт» и «ИИ-агент», окна дозаливки от агента, «Догрузить архив»): тихая пунктирная
// рамка со строкой о том, что сюда класть, и текстовыми кнопками «Выбрать файлы» и
// «Вставить текст» (у архивов только первая); клик по самой зоне тоже открывает выбор файлов. Под зоной
// имена принесённых файлов с крестиком (длинное имя обрезается, целиком — в подсказке) и
// поле текста открытого файла.
//
// Только вид: что считать вставкой, какой файл открыт, что делать с выбранными файлами,
// решает окно. Перетаскивание принимает всё окно (bind useFileDrop на его корне), зона
// только подсвечивается (over).
import { useRef } from "react";
import type { ReactNode } from "react";
import { noAutofill } from "../../ui/noAutofill";
import "../../ui/ds.css";
import "./importParts.css";

/** Строка списка принесённых файлов. */
export interface ZoneFile {
  key: string;
  name: string;
  /** Имя — кнопка: открывает текст файла в поле под списком. */
  openable: boolean;
  /** Этот файл сейчас в поле. */
  active: boolean;
}

/** Поле текста открытого файла; null — поля нет. */
export interface ZoneEditor {
  value: string;
  onChange: (text: string) => void;
  /** Подпись поля для чтения с экрана. */
  label: string;
  placeholder: string;
  /** Ключ имени поля для noAutofill: свой у каждого окна. */
  autofill: string;
}

export default function FileZone({
  text, accept, over, full, onFiles, onPaste, files, onOpen, onRemove, editor, notes,
}: {
  /** Строка в зоне: что сюда класть. */
  text: string;
  /** Расширения для выбора с диска, те же, что у перетаскивания. */
  accept: string[];
  /** Над окном тащат файлы: зона подсвечена. */
  over: boolean;
  /** Предел числа файлов: выбор и вставка выключены. */
  full: boolean;
  onFiles: (list: FileList | null) => void;
  /** «Вставить текст»; без него кнопки нет (архив не текст: «Догрузить архив»). */
  onPaste?: () => void;
  files: ZoneFile[];
  onOpen: (i: number) => void;
  onRemove: (i: number) => void;
  editor: ZoneEditor | null;
  /** Строки под зоной: что из принесённого не взято и почему. */
  notes?: ReactNode;
}) {
  const input = useRef<HTMLInputElement>(null);
  const pick = () => { if (!full) input.current?.click(); };

  return (
    <>
      <div className={"fz-drop" + (over ? " is-over" : "") + (full ? " is-full" : "")} onClick={pick}>
        <p className="fz-drop-text">{text}</p>
        <div className="fz-drop-acts">
          <button type="button" className="ds-add" disabled={full} onClick={(e) => { e.stopPropagation(); pick(); }}>
            Выбрать файлы
          </button>
          {onPaste && (
            <button type="button" className="ds-add" disabled={full} onClick={(e) => { e.stopPropagation(); onPaste(); }}>
              Вставить текст
            </button>
          )}
        </div>
      </div>
      <input
        ref={input}
        type="file"
        multiple
        accept={accept.join(",")}
        hidden
        onChange={(e) => {
          onFiles(e.target.files);
          e.target.value = ""; // тот же файл можно выбрать ещё раз
        }}
      />
      {notes}

      {files.length > 0 && (
        <ul className="fz-files" aria-label="Файлы">
          {files.map((f, i) => (
            <li key={f.key} className="fz-file">
              {f.openable ? (
                <button
                  type="button"
                  className={"fz-file-name" + (f.active ? " is-active" : "")}
                  aria-pressed={f.active}
                  title={f.name}
                  onClick={() => onOpen(i)}
                >
                  {f.name}
                </button>
              ) : (
                <span className="fz-file-name" title={f.name}>{f.name}</span>
              )}
              <button type="button" className="ds-del" aria-label={`Убрать ${f.name}`} title="Убрать" onClick={() => onRemove(i)}>
                ×
              </button>
            </li>
          ))}
        </ul>
      )}

      {editor && (
        <textarea
          {...noAutofill(editor.autofill)}
          className="fz-paste"
          aria-label={editor.label}
          value={editor.value}
          onChange={(e) => editor.onChange(e.target.value)}
          placeholder={editor.placeholder}
          spellCheck={false}
        />
      )}
    </>
  );
}
