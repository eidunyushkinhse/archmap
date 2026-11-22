// Оверлей тяжёлой документации узла (Логика / OpenAPI) — тонкий shell: модалка и
// выбор режима. Оба режима устроены одинаково (вьюер v2): чтение → «Изменить»
// → «Вручную» / «Через ИИ-агента», всё в одном окне.
//   • «Логика» — FlowchartDocs: окно ОДНОЙ схемы, свой фетч, CRUD и CAS, мутации
//     репортятся onDocEvent для меты;
//   • OpenAPI — OpenApiPane: спеку пишет страница (onCommitOpenapi → PATCH узла).
// Каркас на новом языке (редизайн, фаза 7а): корень — область .ds, окно во весь экран без
// полей по 32 px (ширина до 1120 px), шапка в одну строку (docChrome.DocHead).
import { useCallback, useEffect, useRef, useState } from "react";
import Modal from "../../ui/Modal";
import FlowchartDocs from "./FlowchartDocs";
import type { NodeDocEvent } from "./FlowchartDocs";
import OpenApiPane from "./OpenApiPane";
import type { DocStage } from "./OpenApiPane";
import "../../ui/ds.css";
import "./docOverlay.css";

interface Props {
  mode: "flowchart" | "openapi";
  nodeId: string;
  nodeName: string;
  // Сохранённая спека узла (режим OpenAPI; в «Логике» не нужна).
  openapi?: string;
  isArchitect: boolean;
  // Записать спеку (режим OpenAPI): true — сохранено, false — конфликт версий.
  onCommitOpenapi?: (value: string) => Promise<boolean>;
  onDocEvent: (evt: NodeDocEvent) => void;
  onClose: () => void;
  // «+ Добавить → Вручную» со страницы: окно сразу в «Вручную» для новой схемы,
  // схема создаётся только по «Сохранить» (режим «Логика»)
  createNew?: boolean;
  // С чего открыть окно спеки: «+ Добавить → Вручную / Через ИИ-агента».
  initialStage?: DocStage;
  // Открыть окно на конкретной схеме (клик по строке в секции «Логика», шаг процесса)
  initialDocId?: string;
  // Уведомление о конфликте конкурентных сессий (409 CAS при записи спеки со
  // страницы): сохранение не применилось — показываем строкой под шапкой, панель за
  // модалкой пользователь не видит. У схем логики своя строка в FlowchartDocs.
  notice?: string | null;
  // Пакет агента применён (в историю не кладётся) — страница освежает мету узла.
  onApplied?: () => void;
  // Переход в процесс из строки «В процессах» под схемой.
  onOpenProcess?: (processId: string) => void;
}

// Режим «Логика» спеку не пишет — заглушка вместо колбэка, которого нет.
const noCommit = (): Promise<boolean> => Promise.resolve(false);

export default function DocOverlay({
  mode, nodeId, nodeName, openapi, isArchitect, onCommitOpenapi, onDocEvent, onClose,
  createNew, initialStage, initialDocId, notice, onApplied, onOpenProcess,
}: Props) {
  // Несохранённая правка «Вручную» (пишут панели). Крестик и Escape при ней не
  // закрывают окно молча, а спрашивают (решение пользователя 2026-09-29).
  const dirtyRef = useRef(false);
  const [confirmClose, setConfirmClose] = useState(false);
  const requestClose = useCallback(() => {
    // Escape при открытом вопросе — «Вернуться к правке».
    if (confirmClose) setConfirmClose(false);
    else if (dirtyRef.current) setConfirmClose(true);
    else onClose();
  }, [confirmClose, onClose]);

  return (
    <Modal onClose={requestClose} closeButton={false} boxStyle={{ padding: 0 }}>
      <div className="ds doc-root">
        {/* Вопрос — слоем внутри окна, а не вложенным <dialog> (ловушка Modal). */}
        {confirmClose && <ConfirmClose onBack={() => setConfirmClose(false)} onClose={onClose} />}
        {mode === "flowchart" ? (
          <FlowchartDocs
            nodeId={nodeId}
            nodeName={nodeName}
            isArchitect={isArchitect}
            onDocEvent={onDocEvent}
            onClose={onClose}
            onRequestClose={requestClose}
            dirtyRef={dirtyRef}
            createNew={createNew}
            initialDocId={initialDocId}
            onApplied={onApplied}
            onOpenProcess={onOpenProcess}
          />
        ) : (
          <OpenApiPane
            nodeId={nodeId}
            nodeName={nodeName}
            openapi={openapi ?? ""}
            isArchitect={isArchitect}
            onCommitOpenapi={onCommitOpenapi ?? noCommit}
            notice={notice}
            onClose={onClose}
            onRequestClose={requestClose}
            dirtyRef={dirtyRef}
            initialStage={initialStage}
            onApplied={onApplied}
          />
        )}
      </div>
    </Modal>
  );
}

// «Закрыть без сохранения?»: главная кнопка «Вернуться к правке» первой и в фокусе (вопрос
// появляется поверх уже открытого окна, поэтому data-autofocus окна до него не доходит),
// «Закрыть» за ней цветом опасного действия.
function ConfirmClose({ onBack, onClose }: { onBack: () => void; onClose: () => void }) {
  const backRef = useRef<HTMLButtonElement>(null);
  useEffect(() => { backRef.current?.focus(); }, []);
  return (
    <div className="doc-confirm-layer">
      <div className="doc-confirm" role="alertdialog" aria-label="Закрыть без сохранения?">
        <h2 className="ds-win-title">Закрыть без сохранения?</h2>
        <p>Несохранённые правки пропадут.</p>
        <div className="doc-confirm-actions">
          <button type="button" ref={backRef} className="ds-btn ds-btn--primary" onClick={onBack}>
            Вернуться к правке
          </button>
          <button type="button" className="ds-btn doc-confirm-close" onClick={onClose}>
            Закрыть
          </button>
        </div>
      </div>
    </div>
  );
}
