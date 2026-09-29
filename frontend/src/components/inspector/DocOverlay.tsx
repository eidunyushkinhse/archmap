// Оверлей тяжёлой документации узла (Логика / OpenAPI) — тонкий shell: модалка и
// выбор режима. Оба режима устроены одинаково (вьюер v2): просмотр → «Изменить»
// → «Вручную» / «Через ИИ-агента», всё в одном окне.
//   • «Логика» — FlowchartDocs: окно ОДНОЙ схемы, свой фетч, CRUD и CAS, мутации
//     репортятся onDocEvent для меты;
//   • OpenAPI — OpenApiPane: спеку пишет страница (onCommitOpenapi → PATCH узла).
import Modal from "../../ui/Modal";
import FlowchartDocs from "./FlowchartDocs";
import type { NodeDocEvent } from "./FlowchartDocs";
import OpenApiPane from "./OpenApiPane";
import type { DocStage } from "./OpenApiPane";
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
  // страницы): сохранение не применилось — показываем прямо в шапке, панель за
  // модалкой пользователь не видит. У схем логики свой баннер в FlowchartDocs.
  notice?: string | null;
  // Пакет агента применён (в историю не кладётся) — страница освежает мету узла.
  onApplied?: () => void;
  // Переход в процесс из строки «Используется в процессах» просмотра схемы.
  onOpenProcess?: (processId: string) => void;
}

// Режим «Логика» спеку не пишет — заглушка вместо колбэка, которого нет.
const noCommit = (): Promise<boolean> => Promise.resolve(false);

export default function DocOverlay({
  mode, nodeId, nodeName, openapi, isArchitect, onCommitOpenapi, onDocEvent, onClose,
  createNew, initialStage, initialDocId, notice, onApplied, onOpenProcess,
}: Props) {
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
          <OpenApiPane
            nodeId={nodeId}
            nodeName={nodeName}
            openapi={openapi ?? ""}
            isArchitect={isArchitect}
            onCommitOpenapi={onCommitOpenapi ?? noCommit}
            notice={notice}
            onClose={onClose}
            initialStage={initialStage}
            onApplied={onApplied}
          />
        )}
      </div>
    </Modal>
  );
}
