// Окно последствий смены элемента архитектуры или переноса узла (Р18): одно на шесть
// видов, рендерит ElementChangePreview сервера. Блоки «Площадки» (строки «Сейчас» и
// «Станет», пояснение под ними) и «Документация» появляются, только если им есть что
// показать. Строка площадок: имя объекта и его площадки обычным текстом через запятую.
// Главная кнопка первой, «Отмена» за ней; «Отмена» ничего не меняет.
import type { ElementChangePreview, PlacementRowOut } from "../../types";
import ConfirmDialog from "../../ui/ConfirmDialog";
import "../../ui/ds.css";
import { consequenceTexts, placementsMove } from "./elementChange";

interface Props {
  preview: ElementChangePreview;
  // Объект, у которого меняют элемент или который переносят.
  nodeName: string;
  // Куда переносят (перенос в дереве); у смены типа его нет.
  targetName?: string;
  onConfirm: () => void;
  onCancel: () => void;
}

// Группа строк под тихой подписью («Сейчас» или «Станет»).
function Rows({ caption, rows, label }: { caption: string; rows: PlacementRowOut[]; label: string }) {
  return (
    <div className="ds-confirm-group">
      <div className="ds-confirm-cap">{caption}</div>
      <div role="list" aria-label={label} className="ds-confirm-rows">
        {rows.map((row) => (
          <div key={row.node_id} role="listitem" className="ds-confirm-row">
            <span className="ds-confirm-row-name" title={row.name}>{row.name}</span>
            <span className="ds-confirm-row-value">{row.sites.join(", ")}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

export default function ElementChangeDialog({ preview, nodeName, targetName, onConfirm, onCancel }: Props) {
  const t = consequenceTexts(preview, nodeName, targetName);
  return (
    <ConfirmDialog
      tone="neutral"
      title={t.title}
      lead={t.lead}
      confirmLabel={t.confirm}
      onConfirm={onConfirm}
      onCancel={onCancel}
    >
      {placementsMove(preview) && (
        <section className="ds-win-block">
          <h3 className="ds-win-block-title">Площадки</h3>
          <Rows caption="Сейчас" rows={preview.before} label="Площадки до" />
          {/* Пустой системе (Р39) площадки отдать некому: строк «после» и подписи «Станет» нет. */}
          {preview.after.length > 0 && <Rows caption="Станет" rows={preview.after} label="Площадки после" />}
          <p className="ds-confirm-note">{t.placementNote}</p>
        </section>
      )}
      {t.docs && (
        <section className="ds-win-block">
          <h3 className="ds-win-block-title">Документация</h3>
          <p className="ds-confirm-note">{t.docs}</p>
        </section>
      )}
    </ConfirmDialog>
  );
}
