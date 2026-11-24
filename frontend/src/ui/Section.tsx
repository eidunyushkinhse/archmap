// Раздел переведённой страницы (редизайн, направление А): заголовок 16px/600 и действия
// раздела справа в одной строке, под ними содержимое. Одна разметка на все разделы
// страницы объекта и главной проекта; стили — ui/ds.css.
import type { ReactNode } from "react";
import "./ds.css";

export default function Section({ title, actions, children, tour }: {
  title: string;
  // Действия раздела у правого края строки заголовка («Добавить», вторичные кнопки).
  actions?: ReactNode;
  children?: ReactNode;
  // Метка шага обучающего тура, если тур смотрит на этот раздел.
  tour?: string;
}) {
  return (
    <section className="ds-sec" data-tour={tour}>
      <div className="ds-sec-head">
        <h3 className="ds-sec-title">{title}</h3>
        {actions && <div className="ds-sec-acts">{actions}</div>}
      </div>
      {children}
    </section>
  );
}
