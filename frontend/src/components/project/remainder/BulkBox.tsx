// Массовые ответы догрузки (§7 ТЗ). Отдельный блок под вопросами, а не кнопки
// внутри них: догрузка часто приезжает десятком одинаковых споров с живым
// знанием, и проходить их по одному незачем — а вот жесты (перевес, новая связь,
// склейка) массовой кнопкой не закрываются никогда.
import "./remainder.css";

interface Props {
  onKeepMine: () => void;
  onTakeArchives: () => void;
}

export default function BulkBox({ onKeepMine, onTakeArchives }: Props) {
  return (
    <div className="rq-root rq-bulk">
      <span className="rq-bulk-l">Решить все конфликты одной кнопкой:</span>
      <button type="button" className="rq-soft" onClick={onKeepMine}>
        Оставить, как было в проекте
      </button>
      <button type="button" className="rq-soft" onClick={onTakeArchives}>
        Взять из новых архивов
      </button>
    </div>
  );
}
