// Массовые ответы догрузки (§7 ТЗ). Отдельный блок под вопросами, а не кнопки
// внутри них: догрузка часто приезжает десятком одинаковых споров с живым
// знанием, и проходить их по одному незачем — а вот жесты (перевес, новая связь,
// склейка) массовой кнопкой не закрываются никогда. Кнопки — вторичные ds-btn нового
// языка, подпись тихим цветом (фаза 8а) и называет, на что отвечают кнопки: на
// расхождения с проектом (фаза 8б).
import "../../../ui/ds.css";
import "./remainder.css";

interface Props {
  onKeepMine: () => void;
  onTakeArchives: () => void;
}

export default function BulkBox({ onKeepMine, onTakeArchives }: Props) {
  return (
    <div className="rq-root rq-bulk">
      <span className="rq-bulk-l">Ответить на все расхождения с проектом сразу:</span>
      <button type="button" className="ds-btn" onClick={onKeepMine}>
        Оставить, как было в проекте
      </button>
      <button type="button" className="ds-btn" onClick={onTakeArchives}>
        Взять из новых архивов
      </button>
    </div>
  );
}
