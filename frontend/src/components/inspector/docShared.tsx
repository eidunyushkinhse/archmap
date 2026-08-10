// Общие компоненты DocOverlay для обоих режимов (Логика / OpenAPI): колонка
// редактора с blur-коммитом и страховкой при размонтировании, варианты
// статус-строки. Разметка и токены — по ТЗ «Визуализация Mermaid и OpenAPI».
import { useEffect, useRef, useState } from "react";
import type { ReactNode, RefObject } from "react";

interface EditorProps {
  width: number; // flowchart 440 / openapi 460 (Часть A1 ТЗ)
  title: string; // caps-заголовок «Код · mermaid flowchart» / «Код · OpenAPI 3.0 (YAML)»
  placeholder: string;
  value: string;
  readOnly: boolean;
  onChange?: (v: string) => void;
  // Коммит значения: по blur и страховкой при размонтировании (если blur не успел —
  // Esc/крестик при фокусе в textarea). Вызывается только при реальном изменении
  // с момента последнего коммита; двойной вызов безопасен (commitDoc сверяет).
  onCommitValue?: (v: string) => void;
  status: ReactNode; // готовая статус-строка (Часть D)
  taRef?: RefObject<HTMLTextAreaElement | null>; // для каретки по клику на ошибку
  // Приём файла — маска для диалога выбора. Передан (и колонка редактируемая) →
  // в шапке кнопка «Загрузить файл», поле принимает перетаскивание. Не передан —
  // ни кнопки, ни drop-зоны (у схем логики файла обычно нет — там пишут руками).
  fileAccept?: string;
  // Отказ принять файл. Снимать сообщение — забота вызывающего: оно гаснет на
  // следующей правке (иначе висело бы поверх нормального статуса разбора).
  onFileError?: (message: string) => void;
  // Подготовка содержимого файла перед укладкой в редактор (у логики — снятие
  // markdown-обёртки). Применяется ТОЛЬКО к файлу: то же самое, набранное руками,
  // трогать нельзя — человек написал это сознательно.
  prepareFile?: (text: string) => string;
}

// Потолок размера файла: спеки бывают в несколько мегабайт (Stripe ~5 МБ), но
// десятки — это уже не спека, а промах в диалоге. Читать такое в textarea значит
// подвесить вкладку.
const FILE_LIMIT = 8 * 1024 * 1024;

export function DocEditorColumn({
  width,
  title,
  placeholder,
  value,
  readOnly,
  onChange,
  onCommitValue,
  status,
  taRef,
  fileAccept,
  onFileError,
  prepareFile,
}: EditorProps) {
  // На маунте value == сохранённому значению из БД
  const committedRef = useRef(value);
  // Зеркала для cleanup-страховки — писать в ref в рендере нельзя (react-hooks/refs)
  const valueRef = useRef(value);
  const commitCbRef = useRef(onCommitValue);
  useEffect(() => {
    valueRef.current = value;
    commitCbRef.current = onCommitValue;
  });

  const commitBlur = () => {
    if (!onCommitValue || value === committedRef.current) return;
    committedRef.current = value;
    setDirty(false);
    onCommitValue(value);
  };

  // Есть несохранённые правки (для доступности кнопки «Сохранить»). Взводится в
  // onChange, гасится в коммите; ремаунт по key (смена дока/409) сбрасывает сам.
  const [dirty, setDirty] = useState(false);

  // ── Загрузка из файла ──────────────────────────────────────────────────────
  // Содержимое кладётся в редактор ОБЫЧНОЙ правкой (тот же onChange, что у
  // печати), поэтому дальше работает всё привычное: разбор с превью, статус-строка,
  // «Сохранить»/blur-коммит, страховка при закрытии. Отдельного канала записи нет
  // намеренно — иначе файл затирал бы спеку молча, до того как её увидели.
  const fileRef = useRef<HTMLInputElement>(null);
  const [overDrop, setOverDrop] = useState(false);
  const canLoadFile = !!fileAccept && !readOnly && !!onChange;

  const loadFile = async (file: File | undefined | null) => {
    if (!file || !onChange) return;
    if (file.size > FILE_LIMIT) {
      onFileError?.(`Файл больше ${FILE_LIMIT / 1024 / 1024} МБ — это не похоже на спеку`);
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
    setDirty(true);
  };

  // Страховка A3: dirty-значение коммитится из cleanup, если blur не успел
  useEffect(
    () => () => {
      const cb = commitCbRef.current;
      if (cb && valueRef.current !== committedRef.current) {
        committedRef.current = valueRef.current;
        cb(valueRef.current);
      }
    },
    [],
  );

  return (
    <div className="doc-edcol" style={{ width }}>
      <div className="doc-edhead">
        <span>{title}</span>
        <div className="doc-edact">
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
                className="doc-savebtn doc-filebtn"
                onClick={() => fileRef.current?.click()}
                title="Взять спеку из файла (.yaml / .yml / .json). Файл можно и перетащить на поле"
              >
                Загрузить файл
              </button>
            </>
          )}
          {/* Явное сохранение (архитектор): дублирует blur-коммит — финализирует
              новую схему/версию/спеку без ухода фокусом. Неактивна без правок. */}
          {!readOnly && onCommitValue && (
            <button type="button" className="doc-savebtn" onClick={commitBlur} disabled={!dirty}>
              Сохранить
            </button>
          )}
        </div>
      </div>
      <textarea
        ref={taRef}
        className={"doc-edta" + (overDrop ? " doc-edta--drop" : "")}
        value={value}
        placeholder={placeholder}
        readOnly={readOnly}
        onChange={onChange ? (e) => { onChange(e.target.value); setDirty(true); } : undefined}
        onBlur={readOnly ? undefined : commitBlur}
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
      {status}
    </div>
  );
}

// ── статус-строки (Часть D) ──────────────────────────────────────────────────

export function StatusOk({ savedAt }: { savedAt: string | null }) {
  return (
    <div className="doc-edstat doc-edstat--ok">
      <span className="doc-stico">
        <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
          <path d="M3 8.5 6.5 12 13 4.5" />
        </svg>
      </span>
      Синтаксис корректен
      {savedAt && <span className="doc-edstat-r">сохранено · {savedAt}</span>}
    </div>
  );
}

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

// Ошибка. Когда известна строка и передан taRef — это кнопка «поставить каретку
// на строку N», иначе — простой текст той же раскраски.
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
      <span className="doc-stico">
        <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6">
          <circle cx="8" cy="8" r="6.2" />
          <path d="M8 5v3.6M8 11h.01" strokeLinecap="round" />
        </svg>
      </span>
      <span className="doc-edstat-msg" title={text}>{text}</span>
    </>
  );
  if (!line || !taRef) return <div className="doc-edstat doc-edstat--err">{inner}</div>;
  return (
    <button
      type="button"
      className="doc-edstat doc-edstat--err doc-edstat--btn"
      onClick={() => { if (taRef.current) caretToLine(taRef.current, line); }}
    >
      {inner}
    </button>
  );
}

// Нейтральная строка read-only колонки наблюдателя (Часть E).
export function StatusReadOnly() {
  return (
    <div className="doc-edstat">
      <span className="doc-stico" style={{ color: "#94a3b8" }}>
        <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5">
          <rect x="3" y="7" width="10" height="6.5" rx="1.5" />
          <path d="M5.5 7V5a2.5 2.5 0 0 1 5 0v2" />
        </svg>
      </span>
      Копировать можно, править — нельзя
    </div>
  );
}

// Нейтральная строка ожидания (первичная загрузка ленивого рендерера).
export function StatusNote({ text }: { text: string }) {
  return <div className="doc-edstat">{text}</div>;
}
