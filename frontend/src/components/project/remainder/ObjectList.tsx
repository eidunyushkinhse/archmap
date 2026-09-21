// Список объектов (§5.3 ТЗ): компоненты контейнера в вопросе о связи и пикер
// концов новой связи. Первые четыре видны сразу, остальные — по ссылке «Показать
// остальные N», и только там появляется фильтр: крупные системы дают сотни путей,
// а решение почти всегда принимается по первым строкам.
//
// Раскрытие и фильтр — СОБСТВЕННОЕ состояние списка. Чтобы они не переезжали с
// вопроса на вопрос, вызывающий монтирует список с key по id вопроса (React
// пересоздаёт компонент — состояние начинается с нуля).
import { useState } from "react";
import type { ComponentOut } from "../../../types";
import { plural } from "../../../ui/plural";
import Option, { PathLabel } from "./Option";

interface Props {
  items: ComponentOut[];
  /** Путь контейнера: его префикс у подписей отбрасывается. */
  base?: string | null;
  value?: string | null;
  onPick: (path: string) => void;
}

// Кап показа (§5.3): четыре варианта — предел, за которым список читают, а не видят.
const CAP = 4;

export default function ObjectList({ items, base = null, value = null, onPick }: Props) {
  const [expanded, setExpanded] = useState(false);
  const [filter, setFilter] = useState("");
  const q = filter.trim().toLowerCase();
  const hit = q === "" ? items : items.filter((x) => x.path.toLowerCase().includes(q));
  const shown = expanded ? hit : hit.slice(0, CAP);

  // Ключ — путь И позиция: одинаковый путь в списке ЗАКОНЕН. Тёзки с
  // противоречащими якорями мердж оставляет раздельно («Ярмарка / Каталог-БД»
  // дважды), и по одному пути React ругался на дубль ключей, а строки могли
  // схлопнуться. Позиция в наборе стабильна на время показа списка.
  const rows = shown.map((x, i) => (
    <Option
      key={`${x.path}#${i}`}
      main={<PathLabel path={x.path} base={base} />}
      title={x.path}
      tag={x.has_children ? "контейнер" : undefined}
      selected={value === x.path}
      onClick={() => onPick(x.path)}
    />
  ));
  const empty = <div className="rq-empty">Ничего не нашлось</div>;

  return (
    <>
      {expanded && (
        <input
          className="rq-filter"
          value={filter}
          aria-label="Фильтр по имени"
          placeholder={`Фильтр по имени — ${items.length} ${plural(items.length, ["объект", "объекта", "объектов"])}`}
          onChange={(e) => setFilter(e.target.value)}
        />
      )}
      {expanded ? (
        <div className="rq-scroll">
          {shown.length > 0 ? <div className="rq-opts">{rows}</div> : empty}
        </div>
      ) : (
        <>
          {shown.length > 0 ? <div className="rq-opts">{rows}</div> : empty}
          {hit.length > CAP && (
            <div className="rq-more">
              <button type="button" className="rq-link" onClick={() => setExpanded(true)}>
                Показать остальные {hit.length - CAP}
              </button>
            </div>
          )}
        </>
      )}
    </>
  );
}
