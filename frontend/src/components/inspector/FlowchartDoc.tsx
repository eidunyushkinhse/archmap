// Режим «Логика» DocOverlay: mermaid-код + живое превью (Части B2/B3/D/E ТЗ).
// Превью перерисовывается по вводу с дебаунсом; при ошибке держит последний
// удачный svg (у архитектора) или показывает заглушку с текстом ошибки (у
// наблюдателя — его код не меняется, держать нечего). Пан/зум — usePanZoom.
import { useCallback, useEffect, useRef, useState } from "react";
import MermaidRenderer from "../MermaidRenderer";
import type { MmdStatus } from "../MermaidRenderer";
import { usePanZoom } from "../usePanZoom";
import { DocEditorColumn, StatusError, StatusNote, StatusOk, StatusReadOnly } from "./docShared";
import { nowHHMM, unfenceMermaid } from "./docValidate";

interface Props {
  initial: string; // сохранённый flowchart
  isArchitect: boolean;
  showCode: boolean; // наблюдатель нажал «Показать код»
  onCommit: (value: string) => void;
}

// mermaid отдаёт svg с width:100%/max-width — для пан/зума фиксируем натуральный
// размер из viewBox, чтобы масштаб контролировал только transform обёртки.
function pinSvgSize(wrap: HTMLElement | null): void {
  const svg = wrap?.querySelector("svg");
  if (!svg) return;
  const vb = svg.viewBox.baseVal;
  if (vb && vb.width > 0) {
    svg.style.width = `${vb.width}px`;
    svg.style.height = `${vb.height}px`;
    svg.style.maxWidth = "none";
  }
}

export default function FlowchartDoc({ initial, isArchitect, showCode, onCommit }: Props) {
  const [code, setCode] = useState(initial);
  const [status, setStatus] = useState<MmdStatus>({ kind: "loading" });
  const [savedAt, setSavedAt] = useState<string | null>(null);
  const [fileError, setFileError] = useState<string | null>(null);
  const taRef = useRef<HTMLTextAreaElement>(null);

  const stageRef = useRef<HTMLDivElement>(null);
  const pzRef = useRef<HTMLDivElement>(null);
  const pz = usePanZoom(stageRef, pzRef);
  const { fitInitial } = pz;
  const fittedRef = useRef(false);

  const handleStatus = useCallback(
    (s: MmdStatus) => {
      setStatus(s);
      if (s.kind === "ok") {
        pinSvgSize(pzRef.current);
        // Первый удачный рендер вписываем (не раздувая мелкие диаграммы сверх 100%);
        // дальше пан/зум пользователя не сбрасываем — превью живёт при печати.
        if (!fittedRef.current) {
          fittedRef.current = true;
          fitInitial();
        }
      }
    },
    [fitInitial],
  );

  // «Показать/Скрыть код» наблюдателя меняет ширину превью — вписываем заново
  // (кадром позже, после релейаута), иначе диаграмма уезжает под колонку.
  const { fit } = pz;
  const prevShowCode = useRef(showCode);
  useEffect(() => {
    if (prevShowCode.current === showCode) return;
    prevShowCode.current = showCode;
    if (!fittedRef.current) return;
    const raf = requestAnimationFrame(() => fit());
    return () => cancelAnimationFrame(raf);
  }, [showCode, fit]);

  const commit = useCallback(
    (v: string) => {
      onCommit(v);
      setSavedAt(nowHHMM());
    },
    [onCommit],
  );

  // Отказ принять файл (велик / двоичный / не прочитался). Живёт до следующей
  // правки: как только в поле что-то меняется, статус снова про разбор схемы.
  const handleChange = useCallback((v: string) => {
    setCode(v);
    setFileError(null);
  }, []);

  const hasChart = code.trim().length > 0;
  // Пустой код — не ошибка: статус от последнего рендера уже неактуален
  const shown: MmdStatus = hasChart ? status : { kind: "ok" };
  // Наблюдатель с невалидной сохранённой диаграммой: вместо рендера — заглушка с ошибкой
  const observerError = !isArchitect && shown.kind === "error";

  // Отказ по файлу перекрывает статус разбора: пока он висит, в поле лежит не то,
  // что пользователь выбрал, и сообщать про синтаксис старой схемы — врать.
  const statusRow = !isArchitect ? (
    <StatusReadOnly />
  ) : fileError ? (
    <StatusError text={fileError} />
  ) : shown.kind === "error" ? (
    <StatusError
      text={(shown.line ? `Строка ${shown.line}: ` : "") + shown.message.replace(/\s+/g, " ").trim()}
      line={shown.line}
      taRef={taRef}
    />
  ) : shown.kind === "loading" ? (
    <StatusNote text="Загрузка рендерера…" />
  ) : (
    <StatusOk savedAt={savedAt} />
  );

  return (
    <>
      {(isArchitect || showCode) && (
        <DocEditorColumn
          width={440}
          title="Код · mermaid flowchart"
          placeholder={"graph TD\n  A[Старт] --> B[Конец]"}
          value={code}
          readOnly={!isArchitect}
          onChange={isArchitect ? handleChange : undefined}
          onCommitValue={isArchitect ? commit : undefined}
          status={statusRow}
          taRef={taRef}
          // .md в маске не случайно: схемы чаще всего лежат кусочком markdown —
          // обёртку ```mermaid снимаем при загрузке (prepareFile).
          fileAccept=".mmd,.mermaid,.md,.txt,text/plain,text/markdown"
          fileTitle="Взять схему из файла (.mmd / .mermaid / .md / .txt). Обёртка ```mermaid снимается."
          onFileError={setFileError}
          prepareFile={unfenceMermaid}
        />
      )}
      <div className="doc-pv">
        <div
          ref={stageRef}
          className={"doc-pvstage" + (pz.dragging ? " doc-pvstage--drag" : "")}
          {...pz.handlers}
        >
          {hasChart ? (
            <div ref={pzRef} className="doc-pz" style={{ ...pz.style, ...(observerError ? { display: "none" } : null) }}>
              <MermaidRenderer chart={code} debounceMs={350} onStatus={handleStatus} />
            </div>
          ) : (
            <div className="doc-pvcenter"><span className="doc-pvempty">Нет диаграммы</span></div>
          )}
          {observerError && shown.kind === "error" && (
            <div className="doc-pvcenter">
              <div className="doc-mmderr">В диаграмме ошибка синтаксиса: {shown.message}</div>
            </div>
          )}
          {hasChart && !observerError && (
            <div className="doc-zoom">
              <button type="button" onClick={pz.zoomOut} aria-label="Уменьшить">−</button>
              <span className="doc-zval">{Math.round(pz.scale * 100)}%</span>
              <button type="button" onClick={pz.zoomIn} aria-label="Увеличить">+</button>
              <span className="doc-zsep" />
              <button type="button" onClick={pz.fit} title="Вписать" aria-label="Вписать">
                <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5">
                  <rect x="2.5" y="2.5" width="11" height="11" rx="1.5" />
                </svg>
              </button>
            </div>
          )}
        </div>
      </div>
    </>
  );
}
