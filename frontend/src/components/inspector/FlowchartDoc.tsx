// Режим «Логика» DocOverlay: mermaid-код + живое превью (Части B2/B3/D/E ТЗ).
// Превью перерисовывается по вводу с дебаунсом; при ошибке держит последний
// удачный svg (у архитектора) или показывает заглушку с текстом ошибки (у
// наблюдателя — его код не меняется, держать нечего). Пан/зум — usePanZoom.
import { useCallback, useEffect, useRef, useState } from "react";
import MermaidRenderer from "../MermaidRenderer";
import type { MmdStatus } from "../MermaidRenderer";
import { dataRefsApi } from "../../api/dataRefs";
import type { DataRefPreviewItem } from "../../types";
import { pinSvgSize, usePanZoom } from "../usePanZoom";
import { DocEditorColumn, StatusError, StatusNote, StatusOk, StatusReadOnly } from "./docShared";
import { nowHHMM, unfenceMermaid } from "./docValidate";

interface Props {
  initial: string; // сохранённый flowchart
  isArchitect: boolean;
  showCode: boolean; // наблюдатель нажал «Показать код»
  onCommit: (value: string) => void;
}

// ── плашка «Обращения» ───────────────────────────────────────────────────────
// Пометка «читает:/пишет:» в подписи шага — ЕДИНСТВЕННЫЙ ввод обращений к данным
// (пивот §9 plan-db-docs.md), поэтому её распознавание обязано быть видно прямо во
// время письма: иначе конвенцию не выучить, а промах именем обнаружится когда-то
// потом в панели алертов. Наблюдателю плашка не нужна — пометки он читает в самой
// диаграмме, а исправить всё равно не может.

// Дешёвый локальный гейт: грамматику маркера держит бэк (app/data_refs.py), тут
// достаточно понять, есть ли в тексте хоть один — на доках без данных (их
// большинство) сеть не дёргается вовсе. \b не ставим: в JS он ASCII-ный и перед
// кириллическим «ч» не сработал бы.
const REF_MARKER = /(читает|пишет|reads|writes)\s*:/i;

// Почему пометка не срослась — ТЕ ЖЕ слова, что в панели алертов (SchemaAlerts):
// один факт, увиденный из двух мест, не должен читаться как две разные проблемы.
const REF_REASON: Record<Exclude<DataRefPreviewItem["status"], "ok">, string> = {
  unknown_table: "таблица не найдена",
  ambiguous: "имя неоднозначно — укажите „БД / таблица“",
  unknown_column: "колонки нет в таблице",
};

function DataRefsPlate({ refs }: { refs: DataRefPreviewItem[] }) {
  return (
    <div className="doc-refs">
      <div className="doc-refshead">Обращения</div>
      {refs.map((r, i) => (
        <div key={`${r.mode}:${r.ref}:${i}`} className="doc-refrow">
          <span className={`doc-refmode doc-refmode--${r.mode}`}>
            {r.mode === "write" ? "пишет" : "читает"}
          </span>
          <span className="doc-reftext">
            <span className="doc-refname">{r.ref}</span>{" "}
            {r.status === "ok" ? (
              <span className="doc-refok">→ {r.target} ✓</span>
            ) : (
              // unknown_column: таблица-то нашлась — называем её, иначе непонятно,
              // куда смотреть, чтобы свериться с колонками.
              <span className="doc-refbad">
                ⚠ {REF_REASON[r.status]}
                {r.status === "unknown_column" && r.target ? ` (${r.target})` : ""}
              </span>
            )}
          </span>
        </div>
      ))}
    </div>
  );
}

export default function FlowchartDoc({ initial, isArchitect, showCode, onCommit }: Props) {
  const [code, setCode] = useState(initial);
  const [status, setStatus] = useState<MmdStatus>({ kind: "loading" });
  const [savedAt, setSavedAt] = useState<string | null>(null);
  const [fileError, setFileError] = useState<string | null>(null);
  const taRef = useRef<HTMLTextAreaElement>(null);

  // Разбор пометок обращений для плашки. Текст шлём как есть, включая несохранённый:
  // резолв на бэке — чистая функция, записи он не делает (пивот §9).
  const [refs, setRefs] = useState<DataRefPreviewItem[]>([]);
  const refSeq = useRef(0);
  // Производное — в рендере: нет маркера → нет ни плашки, ни запроса.
  const hasRefMarker = REF_MARKER.test(code);
  useEffect(() => {
    if (!isArchitect || !hasRefMarker) return;
    const seq = ++refSeq.current;
    const t = window.setTimeout(() => {
      dataRefsApi
        .preview(code)
        .then((items) => {
          if (refSeq.current !== seq) return;
          setRefs(items);
        })
        // Плашка — подсказка, а не источник истины: отказ сети гасим молча и держим
        // прежний разбор. Пока ответ в пути, плашка тоже не мигает: старое состояние
        // на полсекунды честнее, чем моргающая пустота на каждый символ.
        .catch(() => undefined);
    }, 600);
    return () => window.clearTimeout(t);
  }, [code, isArchitect, hasRefMarker]);

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
  // Пометки стёрли — плашка уходит сразу, не дожидаясь ответа на прошлый текст.
  const showRefs = isArchitect && hasRefMarker && refs.length > 0;

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
          // Плашка едет ФРАГМЕНТОМ в слот статуса: DocEditorColumn кладёт status
          // последним ребёнком своей flex-колонки, так что второй элемент встаёт
          // ровно под статус-строкой — новый проп общего компонента ничего бы не
          // добавил, а в режиме OpenAPI обращений не бывает вовсе.
          status={
            <>
              {statusRow}
              {showRefs && <DataRefsPlate refs={refs} />}
            </>
          }
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
