// Оверлей тяжёлой документации узла (Логика / OpenAPI) — тонкий shell: модалка и
// выбор режима. Режим «Логика» целиком — FlowchartDocs: окно ОДНОЙ схемы
// (просмотр → «Изменить» → «Вручную» / «Через ИИ-агента», свой фетч, CRUD и CAS,
// мутации репортятся onDocEvent для меты). Режим OpenAPI — прежний OpenApiDoc
// (blur → onCommitOpenapi → nodesApi.update); наблюдателю — сразу рендер, код по кнопке.
import { useCallback, useState } from "react";
import Modal from "../../ui/Modal";
import FlowchartDocs from "./FlowchartDocs";
import type { NodeDocEvent } from "./FlowchartDocs";
import OpenApiDoc from "./OpenApiDoc";
import { ApiGlyph, DocHead } from "./docChrome";
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
  // «+ Добавить → Вручную» со страницы: окно сразу в «Вручную» для новой схемы,
  // схема создаётся только по «Сохранить» (режим «Логика»)
  createNew?: boolean;
  // Открыть окно на конкретной схеме (клик по строке в секции «Логика», шаг процесса)
  initialDocId?: string;
  // Уведомление о конфликте конкурентных сессий (409 CAS от NodeInspector.save,
  // режим OpenAPI): сохранение не применилось — показываем прямо в шапке, панель
  // за модалкой пользователь не видит. У схем логики свой баннер в FlowchartDocs.
  notice?: string | null;
  // Пакет агента применён (в историю не кладётся) — страница освежает мету узла.
  onApplied?: () => void;
  // Переход в процесс из строки «Используется в процессах» просмотра схемы.
  onOpenProcess?: (processId: string) => void;
}

// «3.0.3» → «3.0» для тега «OAS 3.0 · YAML»
function shortVersion(v: string): string {
  return v.split(".").slice(0, 2).join(".");
}

export default function DocOverlay({
  mode, nodeId, nodeName, openapi, isArchitect, onCommitOpenapi, onDocEvent, onClose,
  createNew, initialDocId, notice, onApplied, onOpenProcess,
}: Props) {
  const [showCode, setShowCode] = useState(false);
  // Версия OAS из последнего валидного парса спеки (шлёт OpenApiDoc)
  const [oasVersion, setOasVersion] = useState<string | undefined>(undefined);

  const commitApi = useCallback((v: string) => onCommitOpenapi(v), [onCommitOpenapi]);

  const foot: string = !isArchitect
    ? "Наблюдателю редактирование недоступно"
    : "Невалидная спека сохраняется как черновик — рендер не обновляется до исправления";

  return (
    <Modal onClose={onClose} closeButton={false} boxStyle={{ padding: 0, borderRadius: 14 }}>
      <div className="doc-root">
        {mode === "flowchart" ? (
          <FlowchartDocs
            nodeId={nodeId}
            nodeName={nodeName}
            isArchitect={isArchitect}
            onDocEvent={onDocEvent}
            onClose={onClose}
            createNew={createNew}
            initialDocId={initialDocId}
            onApplied={onApplied}
            onOpenProcess={onOpenProcess}
          />
        ) : (
          <>
            <DocHead
              glyph={<ApiGlyph />}
              title={<>{nodeName} <span>· OpenAPI</span></>}
              tag={oasVersion ? `OAS ${shortVersion(oasVersion)} · YAML` : "OpenAPI · YAML"}
              tagOas
              notice={notice}
              actions={!isArchitect && (
                <button type="button" className="doc-codebtn" onClick={() => setShowCode((s) => !s)}>
                  <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round">
                    <path d="M5.5 5 2.5 8l3 3M10.5 5l3 3-3 3" />
                  </svg>
                  {showCode ? "Скрыть код" : "Показать код"}
                </button>
              )}
              onClose={onClose}
            />
            <div className="doc-body">
              <OpenApiDoc
                initial={openapi}
                isArchitect={isArchitect}
                showCode={showCode}
                onCommit={commitApi}
                onVersion={setOasVersion}
              />
            </div>
            <div className="doc-foot">{foot}</div>
          </>
        )}
      </div>
    </Modal>
  );
}
