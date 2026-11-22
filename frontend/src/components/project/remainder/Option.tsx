// Вариант ответа (§5.1 ТЗ): кнопка на всю ширину с главной строкой, подписью и тегом
// справа. Ничего не предвыбрано — выбор всегда жест человека.
//
// Вариант, который действует без ответа, помечен тихим тегом «по умолчанию» и выглядит
// как остальные (фаза 8а редизайна): он не выбран, пока человек его не выбрал. Пунктир
// keep остался окну «Собрать с компонентов», где вопросы прежнего вида.
import type { ReactNode } from "react";

interface Props {
  /** Главная строка. Полужирное начертание задаёт вызывающий (<b>), как в ТЗ. */
  main: ReactNode;
  sub?: ReactNode;
  /** Тег справа: «система», «контейнер», «изменить»; «как сейчас» в «Собрать с компонентов». */
  tag?: string;
  /** Вариант действует без ответа: тег «по умолчанию» справа. */
  byDefault?: boolean;
  selected?: boolean;
  /** Пунктирная рамка варианта-дефолта прежнего вида (окно «Собрать с компонентов»). */
  keep?: boolean;
  title?: string;
  onClick: () => void;
}

export default function Option({
  main, sub, tag, byDefault = false, selected = false, keep = false, title, onClick,
}: Props) {
  return (
    <button
      type="button"
      className={"rq-opt" + (selected ? " rq-opt--on" : "") + (keep ? " rq-opt--keep" : "")}
      title={title}
      aria-pressed={selected}
      onClick={onClick}
    >
      <span className="rq-opt-b">
        {main}
        {sub !== undefined && <span className="rq-opt-sub">{sub}</span>}
      </span>
      {tag !== undefined && <span className="rq-opt-tag">{tag}</span>}
      {byDefault && <span className="rq-opt-tag rq-opt-def">по умолчанию</span>}
    </button>
  );
}

/**
 * Подпись объекта путём (§5.3): серый префикс и последний сегмент —
 * «Grafana / Сервер Grafana / **Рантайм плагинов**». base — путь контейнера, его
 * префикс отбрасывается: внутри вопроса о контейнере он и так назван.
 */
export function PathLabel({ path, base = null }: { path: string; base?: string | null }) {
  const skip = base && path.startsWith(base + " / ") ? base.split(" / ").length : 0;
  const segments = path.split(" / ").slice(skip);
  const tail = segments[segments.length - 1] ?? path;
  const prefix = segments.slice(0, -1).join(" / ");
  return (
    <>
      {prefix !== "" && <span className="rq-opt-m">{prefix} / </span>}
      <b>{tail}</b>
    </>
  );
}
