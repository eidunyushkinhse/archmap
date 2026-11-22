// Спека в окне DocOverlay: YAML/JSON-редактор + рендер Swagger UI (Части C3/D/E
// ТЗ). Две роли: просмотр (isArchitect=false — только рендер, код по «Показать
// код» наблюдателя) и ручная правка (isArchitect=true). Пишет в БД не он: правка
// уходит наверх черновиком (onDraft), сохраняет окно кнопкой «Сохранить».
// Новый язык (редизайн, фазы 7а и 7б): спецификация колонкой до 860 px на ровном фоне,
// без карточки, при чтении и при правке; колонка кода — на токенах.
// Ввод валидируется с дебаунсом 500ms (swagger-ui тяжёлый — на каждый символ
// не перерисовываем); при ошибке превью держит последнюю корректную версию со строкой
// предупреждения над собой, строка состояния ведёт кареткой на строку ошибки.
import { useCallback, useEffect, useRef, useState } from "react";
import OpenApiViewer from "../OpenApiViewer";
import { NOT_OPENAPI_MESSAGE, parseOpenApiText } from "./docValidate";
import type { SpecStatus } from "./docValidate";
import { DocEditorColumn, StatusError } from "./docShared";
import "../../ui/ds.css";
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
  // Последняя корректная версия спеки: её держит превью, пока в тексте ошибка.
  lastGood: { spec: object } | null;
}

export default function OpenApiDoc({ initial, isArchitect, showCode, onDraft }: Props) {
  const [code, setCode] = useState(initial);
  // Первое открытие: сохранённое значение парсится сразу, без дебаунса
  const [st, setSt] = useState<OasState>(() => {
    const s = parseOpenApiText(initial);
    return { status: s, lastGood: s.kind === "ok" ? { spec: s.spec } : null };
  });
  // Отказ принять файл (велик / двоичный / не прочитался). Живёт до следующей
  // правки: как только в поле что-то меняется, статус снова про разбор спеки.
  const [fileError, setFileError] = useState<string | null>(null);
  const taRef = useRef<HTMLTextAreaElement>(null);

  const applyText = useCallback((text: string) => {
    const s = parseOpenApiText(text);
    setSt((prev) => ({
      status: s,
      lastGood: s.kind === "ok" ? { spec: s.spec } : prev.lastGood,
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

  // Превью: валидная спека — Swagger UI; ошибка — lastGood со строкой предупреждения
  // над ним (или «превью недоступно», если корректной версии не было); пусто — заглушка.
  // Время последнего удачного разбора в строке не пишем: оно ничего не решает.
  const broken = status.kind === "yaml-error" || status.kind === "not-openapi";
  let banner: string | null = null;
  if (broken) {
    banner = lastGood ? "Показан последний текст без ошибок" : "В спецификации ошибка, превью недоступно";
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
      <div className="doc-pv">
        {banner && <p className="ds-warn doc-pvwarn" role="status">{banner}</p>}
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
