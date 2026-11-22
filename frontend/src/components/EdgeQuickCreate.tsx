import { useId } from "react";
import type { Edge } from "../types";
import Modal from "../ui/Modal";
import { CloseIcon } from "../ui/icons";
import { LimitText } from "./demo/DemoLimitToast";
import { useEdgeCreate } from "./useEdgeCreate";
import { noAutofill } from "../ui/noAutofill";
import "../ui/ds.css";

interface Props {
  // Концы связи уже определены жестом: стрелку протянули от source к target (хэндл).
  // Хэндлы из жеста связь больше не несёт (R3): геометрия живёт на пучке display-пары
  // в view_layout — их сохраняет MapEditorPage (persistGestureHandles) после onCreated.
  sourceId: string;
  targetId: string;
  sourceLabel: string;
  targetLabel: string;
  onClose: () => void;
  // created — созданная связь (для отката создания через Undo в MapEditorPage).
  onCreated: (created: Edge) => void;
}

/**
 * Окно «Новая связь» (редизайн, фаза 9б: каркас окна нового языка ui/ds.css, ds-win):
 * концы уже заданы жестом (протянули стрелку от узла на хэндл другого) или выбраны в
 * «Выберите связь» → «Добавить связь»; под заголовком они тихой строкой, ниже строки
 * «подпись — значение» «Описание» и «Технология». Связь создаётся по «Создать связь» или
 * Enter в поле (ui/Modal.onSubmit); «Отмена» и крестик закрывают без создания (раньше
 * связь появлялась сразу пустой — заполнить можно было только через редактирование).
 */
export default function EdgeQuickCreate({
  sourceId, targetId, sourceLabel, targetLabel, onClose, onCreated,
}: Props) {
  const uid = useId();
  const { label, setLabel, technology, setTechnology, saving, error, limit, create } =
    useEdgeCreate(onCreated);
  // Одно действие у кнопки и у Enter в поле; во время создания — ни то ни другое.
  const submit = () => { if (!saving) void create(sourceId, targetId); };

  return (
    <Modal onClose={onClose} onSubmit={submit} closeButton={false} boxStyle={{ width: 440, padding: 0 }}>
      <div className="ds ds-win">
        <div className="ds-win-head">
          <h2 className="ds-win-title">Новая связь</h2>
          <button type="button" className="ds-icon-btn ds-win-close" aria-label="Закрыть" onClick={onClose}>
            <CloseIcon />
          </button>
        </div>

        <div className="ds-win-body">
          <p className="ds-win-lead">{sourceLabel} → {targetLabel}</p>
          <dl className="ds-props">
            <div className="ds-prop">
              <dt className="ds-prop-term"><label htmlFor={`${uid}-label`}>Описание</label></dt>
              <dd className="ds-prop-value">
                <input
                  {...noAutofill("edge-quick-create-1")}
                  id={`${uid}-label`}
                  className="ds-field"
                  value={label}
                  onChange={(e) => setLabel(e.target.value)}
                  placeholder="например, запрос или событие"
                  data-autofocus
                />
              </dd>
            </div>
            <div className="ds-prop">
              <dt className="ds-prop-term"><label htmlFor={`${uid}-tech`}>Технология</label></dt>
              <dd className="ds-prop-value">
                <input
                  {...noAutofill("edge-quick-create-2")}
                  id={`${uid}-tech`}
                  className="ds-field"
                  value={technology}
                  onChange={(e) => setTechnology(e.target.value)}
                  placeholder="например, REST или Kafka"
                />
              </dd>
            </div>
          </dl>
        </div>

        <div className="ds-win-foot">
          {error && <p className="ds-danger ds-win-err">{error}</p>}
          {limit && <p className="ds-danger ds-win-err" role="alert"><LimitText message={limit} /></p>}
          <button type="button" className="ds-btn ds-btn--primary" disabled={saving} onClick={submit}>
            {saving ? "Создаём" : "Создать связь"}
          </button>
          <button type="button" className="ds-btn" onClick={onClose}>Отмена</button>
        </div>
      </div>
    </Modal>
  );
}
