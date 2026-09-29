// Спека в окне DocOverlay: YAML/JSON-редактор + рендер Swagger UI (Части C3/D/E
// ТЗ). Две роли: просмотр (isArchitect=false — только рендер, код по «Показать
// код» наблюдателя) и ручная правка (isArchitect=true). Пишет в БД не он: правка
// уходит наверх черновиком (onDraft), сохраняет окно кнопкой «Сохранить».
// Ввод валидируется с дебаунсом 500ms (swagger-ui тяжёлый — на каждый символ
// не перерисовываем); при ошибке превью держит последнюю корректную версию с
// amber-баннером, статус-строка ведёт кареткой на строку ошибки.
import { useCallback, useEffect, useRef, useState } from "react";
import OpenApiViewer from "../OpenApiViewer";
import { NOT_OPENAPI_MESSAGE, nowHHMM, parseOpenApiText } from "./docValidate";
import type { SpecStatus } from "./docValidate";
import { DocEditorColumn, StatusError, StatusOk, StatusReadOnly } from "./docShared";

interface Props {
  initial: string; // спека на момент открытия (сырой текст; черновик живёт внутри)
  // true — ручная правка (код редактируемый); false — просмотр.
  isArchitect: boolean;
  showCode: boolean; // наблюдатель нажал «Показать код»
  // Каждая правка текста (ввод, файл) — окну: оно держит черновик до «Сохранить».
  onDraft?: (value: string) => void;
  // Версия из последнего валидного парса — для тега формата в шапке оверлея
  onVersion?: (version: string | undefined) => void;
}

interface OasState {
  status: SpecStatus;
  // Последняя корректная версия спеки; time null — «из БД», времени правки нет
  lastGood: { spec: object; time: string | null } | null;
}

export default function OpenApiDoc({ initial, isArchitect, showCode, onDraft, onVersion }: Props) {
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

  // Версию для тега шапки сообщаем на маунте (первичный парс) и при каждом
  // валидном перепарсе; на невалидном вводе тег держит последнее валидное.
  const onVersionRef = useRef(onVersion);
  useEffect(() => {
    onVersionRef.current = onVersion;
  });
  useEffect(() => {
    const s = st.status;
    if (s.kind === "ok") onVersionRef.current?.(s.version);
    // только маунт: дальнейшие обновления шлёт applyText
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const applyText = useCallback((text: string) => {
    const s = parseOpenApiText(text);
    setSt((prev) => ({
      status: s,
      lastGood: s.kind === "ok" ? { spec: s.spec, time: nowHHMM() } : prev.lastGood,
    }));
    if (s.kind === "ok") onVersionRef.current?.(s.version);
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
  // что пользователь выбрал, и сообщать про синтаксис старого текста — врать.
  const statusRow = !isArchitect ? (
    <StatusReadOnly />
  ) : fileError ? (
    <StatusError text={fileError} />
  ) : status.kind === "yaml-error" ? (
    <StatusError
      text={(status.line ? `Строка ${status.line}: ` : "") + status.message.replace(/\s+/g, " ").trim()}
      line={status.line}
      taRef={taRef}
    />
  ) : status.kind === "not-openapi" ? (
    <StatusError text={NOT_OPENAPI_MESSAGE} />
  ) : (
    <StatusOk />
  );

  // Превью: валидная спека — карточка Swagger UI; ошибка — lastGood с баннером
  // (или «превью недоступно», если корректной версии не было); пусто — заглушка.
  const broken = status.kind === "yaml-error" || status.kind === "not-openapi";
  let banner: string | null = null;
  if (broken) {
    banner = lastGood
      ? "Показана последняя корректная версия" + (lastGood.time ? ` · ${lastGood.time}` : "")
      : "Спека не распарсилась — превью недоступно";
  }

  return (
    <>
      {(isArchitect || showCode) && (
        <DocEditorColumn
          width={460}
          title="Код · OpenAPI 3.0 (YAML)"
          placeholder={"openapi: 3.0.0\ninfo:\n  title: My API\n  version: 1.0.0"}
          value={code}
          readOnly={!isArchitect}
          onChange={isArchitect ? handleChange : undefined}
          status={statusRow}
          taRef={taRef}
          // Спеку обычно не пишут руками, а берут готовым файлом. JSON тоже
          // принимаем: js-yaml разбирает его тем же парсером (JSON — подмножество YAML).
          fileAccept=".yaml,.yml,.json,text/yaml,application/json"
          fileTitle="Взять спеку из файла (.yaml / .yml / .json)."
          onFileError={setFileError}
        />
      )}
      <div className="doc-pv">
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
            <div className="doc-pvcenter"><span className="doc-pvempty">Нет спеки</span></div>
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
