// Спека в окне DocOverlay: YAML/JSON-редактор + рендер Swagger UI (Части C3/D/E
// ТЗ). Две роли: просмотр (isArchitect=false — только рендер, код по «Показать
// код» наблюдателя) и ручная правка (isArchitect=true). Пишет в БД не он: правка
// уходит наверх черновиком (onDraft), сохраняет окно кнопкой «Сохранить».
// Чтение — новый язык (редизайн, фаза 7а): спецификация колонкой до 860 px на ровном
// фоне, без карточки; колонка кода — новый язык (фаза 7б), превью при правке — прежнего
// вида.
// Ввод валидируется с дебаунсом 500ms (swagger-ui тяжёлый — на каждый символ
// не перерисовываем); при ошибке превью держит последнюю корректную версию с
// amber-баннером, статус-строка ведёт кареткой на строку ошибки.
import { useCallback, useEffect, useRef, useState } from "react";
import OpenApiViewer from "../OpenApiViewer";
import { NOT_OPENAPI_MESSAGE, nowHHMM, parseOpenApiText } from "./docValidate";
import type { SpecStatus } from "./docValidate";
import { DocEditorColumn, StatusError } from "./docShared";
import "./docOverlay.css";

interface Props {
  initial: string; // спека на момент открытия (сырой текст; черновик живёт внутри)
  // true — ручная правка (код редактируемый); false — просмотр.
  isArchitect: boolean;
  showCode: boolean; // наблюдатель нажал «Показать код»
  // Каждая правка текста (ввод, файл) — окну: оно держит черновик до «Сохранить».
  onDraft?: (value: string) => void;
}

interface OasState {
  status: SpecStatus;
  // Последняя корректная версия спеки; time null — «из БД», времени правки нет
  lastGood: { spec: object; time: string | null } | null;
}

export default function OpenApiDoc({ initial, isArchitect, showCode, onDraft }: Props) {
  const [code, setCode] = useState(initial);
  // Первое открытие: сохранённое значение парсится сразу, без дебаунса
  const [st, setSt] = useState<OasState>(() => {
    const s = parseOpenApiText(initial);
    return { status: s, lastGood: s.kind === "ok" ? { spec: s.spec, time: null } : null };
  });
  // Отказ принять файл (велик / двоичный / не прочитался). Живёт до следующей
  // правки: как только в поле что-то меняется, статус снова про разбор спеки.
  const [fileError, setFileError] = useState<string | null>(null);
  const taRef = useRef<HTMLTextAreaElement>(null);

  const applyText = useCallback((text: string) => {
    const s = parseOpenApiText(text);
    setSt((prev) => ({
      status: s,
      lastGood: s.kind === "ok" ? { spec: s.spec, time: nowHHMM() } : prev.lastGood,
    }));
  }, []);

  // Дебаунс перепарса при печати
  const timerRef = useRef<number | undefined>(undefined);
  const handleChange = useCallback(
    (v: string) => {
      setCode(v);
      setFileError(null);
      onDraft?.(v);
      window.clearTimeout(timerRef.current);
      timerRef.current = window.setTimeout(() => applyText(v), 500);
    },
    [applyText, onDraft],
  );
  useEffect(() => () => window.clearTimeout(timerRef.current), []);

  const { status, lastGood } = st;

  // Отказ по файлу перекрывает статус разбора: пока он висит, в поле лежит не то,
  // что пользователь выбрал, и сообщать про синтаксис старого текста — врать. Ошибки нет —
  // слева пусто. У читателя строки состояния нет вовсе (колонка readOnly).
  const statusRow = !isArchitect ? null : fileError ? (
    <StatusError text={fileError} />
  ) : status.kind === "yaml-error" ? (
    <StatusError
      text={(status.line ? `Строка ${status.line}: ` : "") + status.message.replace(/\s+/g, " ").trim()}
      line={status.line}
      taRef={taRef}
    />
  ) : status.kind === "not-openapi" ? (
    <StatusError text={NOT_OPENAPI_MESSAGE} />
  ) : null;

  // Превью: валидная спека — карточка Swagger UI; ошибка — lastGood с баннером
  // (или «превью недоступно», если корректной версии не было); пусто — заглушка.
  const broken = status.kind === "yaml-error" || status.kind === "not-openapi";
  let banner: string | null = null;
  if (broken) {
    banner = lastGood
      ? "Показан последний текст без ошибок" + (lastGood.time ? ` · ${lastGood.time}` : "")
      : "В спецификации ошибка, превью недоступно";
  }

  const column = (isArchitect || showCode) && (
        <DocEditorColumn
          width={460}
          placeholder={"openapi: 3.0.0\ninfo:\n  title: My API\n  version: 1.0.0"}
          value={code}
          readOnly={!isArchitect}
          onChange={isArchitect ? handleChange : undefined}
          status={statusRow}
          taRef={taRef}
          // Спеку обычно не пишут руками, а берут готовым файлом. JSON тоже
          // принимаем: js-yaml разбирает его тем же парсером (JSON — подмножество YAML).
          fileAccept=".yaml,.yml,.json,text/yaml,application/json"
          fileTitle="Взять спецификацию из файла (.yaml / .yml / .json)."
          onFileError={setFileError}
        />
  );

  return (
    <>
      {column}
      <div className={"doc-pv" + (isArchitect ? "" : " doc-pv--read")}>
        {banner && (
          <div className="doc-banner">
            <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6">
              <path d="M8 2.2 14.6 13H1.4Z" strokeLinejoin="round" />
              <path d="M8 6.5v3M8 11.6h.01" strokeLinecap="round" />
            </svg>
            {banner}
          </div>
        )}
        <div className="doc-pvscroll">
          {status.kind === "empty" && !lastGood ? (
            <div className="doc-pvcenter"><span className="doc-pvempty">Нет спецификации</span></div>
          ) : lastGood ? (
            <div className={"doc-oascard" + (broken ? " doc-dim" : "")}>
              <OpenApiViewer spec={lastGood.spec} />
            </div>
          ) : null}
        </div>
      </div>
    </>
  );
}
