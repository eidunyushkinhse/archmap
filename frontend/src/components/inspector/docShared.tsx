// Общие компоненты DocOverlay для обоих режимов (Логика / OpenAPI): колонка
// редактора кода и варианты строки состояния. Колонка сама ничего не пишет: правка
// уходит наверх через onChange, сохраняет окно явной кнопкой (вьюер v2 — прежний
// коммит по уходу фокуса и страховка при закрытии сняты).
// Новый язык (редизайн, фаза 7б): полосы-заголовка над кодом нет; под кодом строка
// состояния: слева ошибка или тихая заметка (когда всё в порядке, пусто), справа тихая
// кнопка «Загрузить файл». У читателя (readOnly) строки состояния нет.
import { useRef, useState } from "react";
import type { ReactNode, RefObject } from "react";
import { fileTooBigMessage } from "../demo/demoLimits";
import { noAutofill } from "../../ui/noAutofill";
import "../../ui/ds.css";
import "./docOverlay.css";

interface EditorProps {
  width: number; // flowchart 440 / openapi 460 (Часть A1 ТЗ)
  placeholder: string;
  value: string;
  readOnly: boolean;
  onChange?: (v: string) => void;
  // Левая часть строки состояния: ошибка (StatusError) или заметка (StatusNote); null —
  // слева пусто. У читателя не рисуется.
  status?: ReactNode;
  // Под строкой состояния (строки обращений схемы логики). У спецификации обращений не
  // бывает.
  after?: ReactNode;
  taRef?: RefObject<HTMLTextAreaElement | null>; // для каретки по клику на ошибку
  // Приём файла — маска для диалога выбора. Передан (и колонка редактируемая) →
  // справа в строке состояния «Загрузить файл», поле принимает перетаскивание. Не
  // передан — ни кнопки, ни приёма перетаскиванием.
  fileAccept?: string;
  // Отказ принять файл. Снимать сообщение — забота вызывающего: оно гаснет на
  // следующей правке (иначе висело бы поверх нормального статуса разбора).
  onFileError?: (message: string) => void;
  // Подготовка содержимого файла перед укладкой в редактор (у логики — снятие
  // markdown-обёртки). Применяется ТОЛЬКО к файлу: то же самое, набранное руками,
  // трогать нельзя — человек написал это сознательно.
  prepareFile?: (text: string) => string;
  // Первая фраза подсказки кнопки — что именно тут берут из файла и в каком виде.
  // Знает это вызывающий: колонка одна на оба режима, и зашитый текст врал бы в
  // одном из них. Про перетаскивание дописывается общей частью (см. ниже).
  fileTitle?: string;
}

// Вторая половина подсказки — общая: перетаскивание работает одинаково в обоих
// режимах, дублировать её по вызывающим нечего.
const DROP_HINT = "Файл можно и перетащить на поле";

// Потолок размера файла: спеки бывают в несколько мегабайт (Stripe ~5 МБ), но
// десятки — это уже не спека, а промах в диалоге. Читать такое в textarea значит
// подвесить вкладку.
const FILE_LIMIT = 8 * 1024 * 1024;

export function DocEditorColumn({
  width,
  placeholder,
  value,
  readOnly,
  onChange,
  status,
  after,
  taRef,
  fileAccept,
  onFileError,
  prepareFile,
  fileTitle,
}: EditorProps) {
  // ── Загрузка из файла ──────────────────────────────────────────────────────
  // Содержимое кладётся в редактор ОБЫЧНОЙ правкой (тот же onChange, что у
  // печати), поэтому дальше работает всё привычное: разбор с превью, строка состояния,
  // «Сохранить» окна. Отдельного канала записи нет намеренно — иначе файл затирал
  // бы спеку молча, до того как её увидели.
  const fileRef = useRef<HTMLInputElement>(null);
  const [overDrop, setOverDrop] = useState(false);
  const canLoadFile = !!fileAccept && !readOnly && !!onChange;

  const loadFile = async (file: File | undefined | null) => {
    if (!file || !onChange) return;
    // Демо-стенд: файл больше предела стенда в редактор не берём (docs/tasks/demo-mode.md).
    const demoRefusal = fileTooBigMessage(file);
    if (demoRefusal) {
      onFileError?.(demoRefusal);
      return;
    }
    if (file.size > FILE_LIMIT) {
      onFileError?.(`Файл больше ${FILE_LIMIT / 1024 / 1024} МБ. Это не похоже на спецификацию`);
      return;
    }
    let text: string;
    try {
      text = await file.text();
    } catch {
      onFileError?.("Не удалось прочитать файл");
      return;
    }
    // Двоичное содержимое (перетащили картинку/архив) в поле не льём: разбор бы
    // его отверг, но в редакторе остался бы мусор вместо спеки.
    if (text.includes("\u0000")) {
      onFileError?.("Это не текстовый файл");
      return;
    }
    onChange(prepareFile ? prepareFile(text) : text);
  };

  return (
    <div className="doc-edcol" style={{ width }}>
      <textarea
        {...noAutofill("doc-shared-1")}
        ref={taRef}
        className={"doc-edta" + (overDrop ? " doc-edta--drop" : "")}
        value={value}
        placeholder={placeholder}
        readOnly={readOnly}
        onChange={onChange ? (e) => onChange(e.target.value) : undefined}
        onDragOver={canLoadFile ? (e) => { e.preventDefault(); setOverDrop(true); } : undefined}
        onDragLeave={canLoadFile ? () => setOverDrop(false) : undefined}
        onDrop={canLoadFile ? (e) => {
          e.preventDefault();
          setOverDrop(false);
          void loadFile(e.dataTransfer.files?.[0]);
        } : undefined}
        spellCheck={false}
        autoCapitalize="off"
        autoCorrect="off"
      />
      {!readOnly && (
        <div className="doc-edbar">
          <div className="doc-edbar-msg">{status}</div>
          {canLoadFile && (
            <>
              <input
                ref={fileRef}
                type="file"
                className="doc-filein"
                accept={fileAccept}
                onChange={(e) => {
                  void loadFile(e.target.files?.[0]);
                  e.target.value = ""; // тот же файл должен выбираться повторно
                }}
              />
              <button
                type="button"
                className="doc-filebtn"
                onClick={() => fileRef.current?.click()}
                title={fileTitle ? `${fileTitle} ${DROP_HINT}` : DROP_HINT}
              >
                Загрузить файл
              </button>
            </>
          )}
        </div>
      )}
      {after}
    </div>
  );
}

// ── левая часть строки состояния ─────────────────────────────────────────────

// Каретку в начало строки-ошибки + проскроллить textarea так, чтобы строка
// оказалась примерно по центру. line — 1-базный.
function caretToLine(ta: HTMLTextAreaElement, line: number): void {
  const lines = ta.value.split("\n");
  const idx = Math.max(0, Math.min(line - 1, lines.length - 1));
  let offset = 0;
  for (let i = 0; i < idx; i++) offset += lines[i].length + 1;
  ta.focus();
  ta.setSelectionRange(offset, offset);
  const lineHeight = 12 * 1.75; // моно 12px / 1.75 из docOverlay.css
  ta.scrollTop = Math.max(0, idx * lineHeight - ta.clientHeight / 2);
}

// Ошибка: значок и текст цветом ошибки в одну строку с многоточием, полный текст — в
// title. Когда известна строка и передан taRef — это кнопка «поставить каретку на строку
// N», иначе — простой текст той же раскраски.
export function StatusError({
  text,
  line,
  taRef,
}: {
  text: string;
  line?: number;
  taRef?: RefObject<HTMLTextAreaElement | null>;
}) {
  const inner = (
    <>
      <span className="doc-ederr-ico" aria-hidden="true">
        <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6">
          <circle cx="8" cy="8" r="6.2" />
          <path d="M8 5v3.6M8 11h.01" strokeLinecap="round" />
        </svg>
      </span>
      <span className="doc-ederr-msg" title={text}>{text}</span>
    </>
  );
  if (!line || !taRef) return <div className="doc-ederr">{inner}</div>;
  return (
    <button
      type="button"
      className="doc-ederr doc-ederr--btn"
      onClick={() => { if (taRef.current) caretToLine(taRef.current, line); }}
    >
      {inner}
    </button>
  );
}

// Тихая заметка (первичная загрузка ленивого рендерера).
export function StatusNote({ text }: { text: string }) {
  return <div className="doc-ednote">{text}</div>;
}
