import ConfirmDialog from "../../ui/ConfirmDialog";
import { confirmListBox, confirmList } from "../../ui/styles";

/**
 * Подтверждение удаления участника со схемы процесса. Презентационная карточка
 * (без Modal, variant="card"): рендерится в оверлее редактора, как остальные его
 * подтверждения — вкладывать второй <dialog> в модалку редактора нельзя. Вид — общий
 * базовый ConfirmDialog (заголовок, плашка-предупреждение, список, кнопки «Убрать» /
 * «Отмена», Р7 ревизии текстов). Объект со схемы НЕ удаляется, поэтому вопрос —
 * «Убрать из процесса»; в списке — сообщения процесса, проведённые через этого
 * участника: они уйдут вместе с ним.
 */
export interface DelLink {
  id: string;
  label: string; // подпись сообщения (caption/технология/«сообщение»)
  dir: "к" | "от"; // участник — отправитель (к) или получатель (от)
  other: string; // имя другого конца
}

interface Props {
  name: string;
  links: DelLink[];
  deleting: boolean;
  error: string | null;
  onConfirm: () => void;
  onCancel: () => void;
}

export default function ParticipantDeleteConfirm({ name, links, deleting, error, onConfirm, onCancel }: Props) {
  return (
    <ConfirmDialog
      variant="card"
      title={`Убрать «${name}» из процесса?`}
      lead={links.length > 0 ? "Вместе с ним из процесса уйдут его сообщения:" : undefined}
      error={error}
      confirmLabel="Убрать"
      busyLabel="Убираем"
      busy={deleting}
      onConfirm={onConfirm}
      onCancel={onCancel}
    >
      {links.length > 0 && (
        <div style={confirmListBox}>
          <ul style={confirmList}>
            {links.map((l) => (
              <li key={l.id} style={{ marginBottom: 4 }}>
                «{l.label}» {l.dir} {l.other}
              </li>
            ))}
          </ul>
        </div>
      )}
    </ConfirmDialog>
  );
}
