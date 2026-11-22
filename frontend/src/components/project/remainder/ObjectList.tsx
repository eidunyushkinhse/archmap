// Список объектов (§5.3 ТЗ): объекты внутри конца связи в вопросе о ней. До шести
// объектов видны все сразу, без поиска (фаза 8б: «Показать остальные 1» прятала одну
// строку за ссылкой той же высоты). Больше шести — первые четыре видны сразу, остальные
// по ссылке «Показать остальные N», и только там появляется фильтр: крупные системы дают
// сотни путей, а решение почти всегда принимается по первым строкам.
//
// Раскрытый список прокручивается сам (не выше min(360px, 45vh)), а колесо у его края не
// крутит окно; при раскрытии поле поиска и начало списка встают в вид тела окна.
//
// Раскрытие и фильтр — СОБСТВЕННОЕ состояние списка. Чтобы они не переезжали с
// вопроса на вопрос, вызывающий монтирует список с key по id вопроса (React
// пересоздаёт компонент — состояние начинается с нуля).
import { useEffect, useRef, useState } from "react";
import type { ComponentOut } from "../../../types";
import Option, { PathLabel } from "./Option";
import { nestedTag } from "./questionText";
import { noAutofill } from "../../../ui/noAutofill";
import "../../../ui/ds.css";
import "./remainder.css";

interface Props {
  items: ComponentOut[];
  /** Путь контейнера: его префикс у подписей отбрасывается. */
  base?: string | null;
  value?: string | null;
  onPick: (path: string) => void;
}

// До ALL объектов список виден целиком; длиннее — первые CAP и ссылка на остальные (их
// тогда не меньше трёх). Четыре варианта — предел, за которым список читают, а не видят.
const ALL = 6;
const CAP = 4;

export default function ObjectList({ items, base = null, value = null, onPick }: Props) {
  const [expanded, setExpanded] = useState(false);
  const [filter, setFilter] = useState("");
  const blockRef = useRef<HTMLDivElement>(null);
  const short = items.length <= ALL;
  const q = filter.trim().toLowerCase();
  const hit = q === "" ? items : items.filter((x) => x.path.toLowerCase().includes(q));
  const shown = short || expanded ? hit : hit.slice(0, CAP);

  // Раскрытый список — поле поиска и начало списка — встаёт в вид тела окна без ручной
  // прокрутки.
  useEffect(() => {
    if (expanded) blockRef.current?.scrollIntoView({ block: "nearest" });
  }, [expanded]);

  // Ключ — путь И позиция: одинаковый путь в списке ЗАКОНЕН. Тёзки с
  // противоречащими якорями мердж оставляет раздельно («Ярмарка / Каталог-БД»
  // дважды), и по одному пути React ругался на дубль ключей, а строки могли
  // схлопнуться. Позиция в наборе стабильна на время показа списка.
  const rows = shown.map((x, i) => (
    <Option
      key={`${x.path}#${i}`}
      main={<PathLabel path={x.path} base={base} />}
      title={x.path}
      tag={nestedTag(x)}
      selected={value === x.path}
      onClick={() => onPick(x.path)}
    />
  ));
  const empty = <div className="rq-empty">Ничего не нашлось</div>;

  if (expanded) {
    return (
      <div ref={blockRef}>
        <input
          {...noAutofill("object-list-1")}
          className="ds-input rq-filter"
          value={filter}
          aria-label="Поиск по имени"
          placeholder="Поиск по имени"
          onChange={(e) => setFilter(e.target.value)}
        />
        <div className="rq-scroll">
          {shown.length > 0 ? <div className="rq-opts">{rows}</div> : empty}
        </div>
      </div>
    );
  }
  return (
    <>
      {shown.length > 0 ? <div className="rq-opts">{rows}</div> : empty}
      {!short && (
        <div className="rq-more">
          <button type="button" className="ds-add" onClick={() => setExpanded(true)}>
            Показать остальные {items.length - CAP}
          </button>
        </div>
      )}
    </>
  );
}
