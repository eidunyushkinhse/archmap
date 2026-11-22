// Шапка экрана окна версий (редизайн, фаза 9ж; каркас ds-win из ui/ds.css): на экранах
// версии и элемента первой стоит «Назад» (из элемента к версии, из версии к списку),
// дальше заголовок и, на экране элемента, тихое уточнение за ним (категория или путь
// объекта) без точки между ними. Длинный заголовок обрезается многоточием; крестик окна
// стоит в своём углу (ds-win-close) и не уезжает.
import { ChevronIcon, CloseIcon } from "../../../ui/icons";
import "../../../ui/ds.css";
import "./versions.css";

export default function ScreenHead({ title, sub, onBack, onClose }: {
  title: string;
  // Уточнение тихим цветом за заголовком; пустое не рисуется.
  sub?: string;
  // Нет — экран списка, кнопки «Назад» нет.
  onBack?: () => void;
  onClose: () => void;
}) {
  return (
    <div className="ds-win-head vp-head">
      {onBack && (
        <button type="button" className="ds-icon-btn vp-back" onClick={onBack} title="Назад" aria-label="Назад">
          <ChevronIcon size={16} />
        </button>
      )}
      <h2 className="ds-win-title vp-title" title={title}>{title}</h2>
      {sub && <span className="vp-title-sub" title={sub}>{sub}</span>}
      <button type="button" className="ds-icon-btn ds-win-close" aria-label="Закрыть" onClick={onClose}>
        <CloseIcon />
      </button>
    </div>
  );
}
