import ConfirmDialog from "../../ui/ConfirmDialog";
import "../../ui/ds.css";

/**
 * Подтверждение удаления участника со схемы процесса. Презентационная карточка
 * (без Modal, variant="card"): рендерится в оверлее редактора, как остальные его
 * подтверждения — вкладывать второй <dialog> в модалку редактора нельзя. Вид — общий
 * базовый ConfirmDialog (заголовок, пояснение, перечень шагов, кнопки «Убрать» и
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
      lead={links.length > 0 ? "Вместе с ним из процесса уйдут его шаги:" : undefined}
      error={error}
      confirmLabel="Убрать"
      busyLabel="Убираем"
      busy={deleting}
      onConfirm={onConfirm}
      onCancel={onCancel}
    >
      {links.length > 0 && (
        <ul className="ds-confirm-list">
          {links.map((l) => {
            const text = `«${l.label}» ${l.dir} ${l.other}`;
            return <li key={l.id} title={text}>{text}</li>;
          })}
        </ul>
      )}
    </ConfirmDialog>
  );
}
