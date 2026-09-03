// Оверлей тяжёлой документации узла (Логика / OpenAPI) — тонкий shell: шапка с
// тегом формата, футер-подсказка и выбор режима. Режим «Логика» наполняет
// FlowchartDocs (коллекция именованных схем node_docs — свой фетч, CRUD и CAS
// внутри, мутации репортятся onDocEvent для Undo/меты); режим OpenAPI — прежний
// OpenApiDoc (blur → onCommitOpenapi → nodesApi.update → история). Наблюдателю —
// сразу рендер, код по кнопке.
import { useCallback, useState } from "react";
import Modal from "../../ui/Modal";
import { CloseIcon } from "../../ui/icons";
import FlowchartDocs from "./FlowchartDocs";
import type { NodeDocEvent } from "./FlowchartDocs";
import OpenApiDoc from "./OpenApiDoc";
import "./docOverlay.css";

interface Props {
  mode: "flowchart" | "openapi";
  nodeId: string;
  nodeName: string;
  openapi: string;
  isArchitect: boolean;
  onCommitOpenapi: (value: string) => void;
  onDocEvent: (evt: NodeDocEvent) => void;
  onClose: () => void;
  // «+ Добавить» со страницы: сразу создать новую схему (режим «Логика»)
  autoCreate?: boolean;
  // Открыть оверлей на конкретной схеме (клик по строке в секции «Логика»)
  initialDocId?: string;
  // Уведомление о конфликте конкурентных сессий (409 CAS от NodeInspector.save,
  // режим OpenAPI): сохранение не применилось — показываем прямо в шапке, панель
  // за модалкой пользователь не видит. У схем логики свой баннер в FlowchartDocs.
  notice?: string | null;
  // Провал «на чтение» (процессы → доки шага, барьер У7): архитектор пришёл ЧИТАТЬ
  // чужую схему — редактор включается этой явной кнопкой, а не самим фактом провала.
  // Передан вместе с isArchitect=false → в шапке кнопка «Править»; футера в этом
  // режиме нет (подсказка «открыто на чтение» была лишней — находка UI-прохода).
  onRequestEdit?: () => void;
  // Обратная дорога того же переключателя: в режиме правки (isArchitect=true) на
  // месте «Править» стоит «Готово» и возвращает оверлей в чтение. Несохранённое
  // не теряется: клик по кнопке снимает фокус с редактора, а blur уже коммитит.
  // Со страницы объекта не передаётся — там оверлей всегда редактор.
  onRequestView?: () => void;
}

// «3.0.3» → «3.0» для тега «OAS 3.0 · YAML»
function shortVersion(v: string): string {
  return v.split(".").slice(0, 2).join(".");
}

export default function DocOverlay({ mode, nodeId, nodeName, openapi, isArchitect, onCommitOpenapi, onDocEvent, onClose, autoCreate, initialDocId, notice, onRequestEdit, onRequestView }: Props) {
  const [showCode, setShowCode] = useState(false);
  // Версия OAS из последнего валидного парса спеки (шлёт OpenApiDoc)
  const [oasVersion, setOasVersion] = useState<string | undefined>(undefined);

  const commitApi = useCallback((v: string) => onCommitOpenapi(v), [onCommitOpenapi]);

  const isFlow = mode === "flowchart";
  const foot: string | null = !isArchitect
    ? onRequestEdit
      ? null
      : "Наблюдателю редактирование недоступно"
    : isFlow
      ? "Сохраняет кнопка «Сохранить» или потеря фокуса — превью обновляется на лету"
      : "Невалидная спека сохраняется как черновик — рендер не обновляется до исправления";

  return (
    <Modal onClose={onClose} closeButton={false} boxStyle={{ padding: 0, borderRadius: 14 }}>
      <div className="doc-root">
        <div className="doc-head">
          <span className="doc-headglyph">{isFlow ? flowGlyph : apiGlyph}</span>
          <div className="doc-title">
            {nodeName} <span>· {isFlow ? "Логика" : "OpenAPI"}</span>
          </div>
          <span className={"doc-tag" + (isFlow ? "" : " doc-tag--oas")}>
            {isFlow
              ? "mermaid · flowchart"
              : oasVersion
                ? `OAS ${shortVersion(oasVersion)} · YAML`
                : "OpenAPI · YAML"}
          </span>
          {notice && (
            <span className="doc-tag" style={{ background: "#fef3c7", color: "#92400e", borderColor: "#fcd34d" }}>
              {notice}
            </span>
          )}
          {!isArchitect && onRequestEdit && (
            <button type="button" className="doc-codebtn" onClick={onRequestEdit}>
              <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
                <path d="m11.3 2.7 2 2L6.6 11.4l-2.9.9.9-2.9Z" />
              </svg>
              Править
            </button>
          )}
          {isArchitect && onRequestView && (
            <button type="button" className="doc-codebtn" onClick={onRequestView}>
              <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
                <path d="m3 8.5 3 3 7-7" />
              </svg>
              Готово
            </button>
          )}
          {!isArchitect && (
            <button type="button" className="doc-codebtn" onClick={() => setShowCode((s) => !s)}>
              <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round">
                <path d="M5.5 5 2.5 8l3 3M10.5 5l3 3-3 3" />
              </svg>
              {showCode ? "Скрыть код" : "Показать код"}
            </button>
          )}
          <button type="button" className="doc-x" onClick={onClose} aria-label="Закрыть">
            <CloseIcon />
          </button>
        </div>

        <div className="doc-body">
          {isFlow ? (
            <FlowchartDocs
              nodeId={nodeId}
              isArchitect={isArchitect}
              showCode={showCode}
              onDocEvent={onDocEvent}
              autoCreate={autoCreate}
              initialDocId={initialDocId}
            />
          ) : (
            <OpenApiDoc
              initial={openapi}
              isArchitect={isArchitect}
              showCode={showCode}
              onCommit={commitApi}
              onVersion={setOasVersion}
            />
          )}
        </div>

        {foot && <div className="doc-foot">{foot}</div>}
      </div>
    </Modal>
  );
}

// Глифы режима в шапке — те же, что на кнопках-строках «Документация» в панели
const gs = {
  width: 16, height: 16, viewBox: "0 0 16 16", fill: "none",
  stroke: "currentColor", strokeWidth: 1.5, strokeLinecap: "round", strokeLinejoin: "round",
} as const;
const flowGlyph = (
  <svg {...gs}>
    <circle cx="4" cy="4" r="1.8" />
    <circle cx="12" cy="8" r="1.8" />
    <circle cx="4" cy="12" r="1.8" />
    <path d="M5.6 4H9a1.7 1.7 0 0 1 1.7 1.7v.6 M5.6 12H9a1.7 1.7 0 0 0 1.7-1.7v-.6" />
  </svg>
);
const apiGlyph = (
  <svg {...gs}>
    <rect x="2" y="3" width="12" height="10" rx="1.5" />
    <path d="M5 6.5 3.5 8 5 9.5 M11 6.5 12.5 8 11 9.5 M8.6 5.7 7.4 10.3" />
  </svg>
);
