// Вариант ответа (§5.1 ТЗ): крупная кнопка на всю ширину с главной строкой,
// подписью и тегом справа. Ничего не предвыбрано — выбор всегда жест человека.
//
// Вариант «как сейчас» (keep) рисуется пунктиром: дефолт виден таким же вариантом,
// как остальные, но не спорит с ними за внимание.
import type { ReactNode } from "react";

interface Props {
  /** Главная строка. Полужирное начертание задаёт вызывающий (<b>), как в ТЗ. */
  main: ReactNode;
  sub?: ReactNode;
  /** Тег справа: «как сейчас», «контейнер», «изменить», «выбираете». */
  tag?: string;
  selected?: boolean;
  /** Пунктирная рамка варианта-дефолта. */
  keep?: boolean;
  title?: string;
  onClick: () => void;
}

export default function Option({ main, sub, tag, selected = false, keep = false, title, onClick }: Props) {
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
    </button>
  );
}

/**
 * Подпись объекта путём (§5.3): серый префикс и полужирный последний сегмент —
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
