// Выбор объекта слитого дерева КОМБОБОКСОМ (П4 v2 приёмки): само поле и есть
// фильтр — человек начинает печатать имя, и список под полем сужается. Прежняя
// панель «раскрой список, потом найди в нём поле поиска» была лишним шагом там,
// где нужен один жест.
//
// Список — обычный absolute-дропдаун под полем: строка формы и так узкая, а
// разворачивать его в потоке значило бы раздвигать соседние строки на каждый
// клик.
import { useEffect, useId, useMemo, useRef, useState } from "react";
import type { ComponentOut } from "../../../types";
import { lastSegment } from "./questionText";
import { PathLabel } from "./Option";

interface Props {
  /** Объекты, из которых выбирают (левый объект строки сюда не попадает). */
  items: ComponentOut[];
  value: string | null;
  onChange: (path: string | null) => void;
  /** Подпись поля для скринридера — в строке формы видимой подписи нет. */
  label: string;
}

export default function ObjectCombobox({ items, value, onChange, label }: Props) {
  const listId = useId();
  const wrapRef = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  // null — поле показывает выбранное; строка — человек печатает фильтр.
  const [query, setQuery] = useState<string | null>(null);
  const [active, setActive] = useState(0);

  const q = (query ?? "").trim().toLowerCase();
  const hits = useMemo(
    () => (q === ""
      ? items
      : items.filter((x) => x.path.toLowerCase().includes(q)
        || lastSegment(x.path).toLowerCase().includes(q))),
    [items, q],
  );
  // Подсветка не должна улетать за конец списка при наборе фильтра.
  const cur = hits.length === 0 ? -1 : Math.min(active, hits.length - 1);

  // Клик мимо закрывает список — и заодно гарантирует «открыт только один за раз».
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      const t = e.target instanceof Node ? e.target : null;
      if (t !== null && wrapRef.current?.contains(t)) return;
      setOpen(false);
      setQuery(null);
    };
    document.addEventListener("mousedown", onDown, true);
    return () => document.removeEventListener("mousedown", onDown, true);
  }, [open]);

  function choose(path: string) {
    onChange(path);
    setQuery(null);
    setOpen(false);
  }

  function onKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === "Escape") {
      if (!open) return;
      // Escape гасит СПИСОК, а не окно ввоза под ним и не разбор вопросов.
      e.preventDefault();
      e.stopPropagation();
      setOpen(false);
      setQuery(null);
      return;
    }
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      if (!open) { setOpen(true); return; }
      if (hits.length === 0) return;
      setActive((i) => {
        const next = e.key === "ArrowDown" ? i + 1 : i - 1;
        return Math.min(hits.length - 1, Math.max(0, next));
      });
      return;
    }
    if (e.key === "Enter" && open && cur >= 0) {
      e.preventDefault();
      const hit = hits[cur];
      if (hit !== undefined) choose(hit.path);
    }
  }

  return (
    <div className="rq-cbo" ref={wrapRef}>
      <input
        className="rq-inp rq-cbo-inp"
        role="combobox"
        aria-expanded={open}
        aria-controls={listId}
        aria-autocomplete="list"
        aria-label={label}
        // Путь длиннее поля обрезается визуально — title отдаёт его целиком.
        title={value ?? undefined}
        placeholder="Начните вводить имя объекта"
        value={query ?? value ?? ""}
        onChange={(e) => { setQuery(e.target.value); setActive(0); setOpen(true); }}
        onFocus={() => setOpen(true)}
        onKeyDown={onKeyDown}
      />
      {value !== null && query === null && (
        <button
          type="button"
          className="rq-cbo-x"
          aria-label="Очистить выбор"
          title="Очистить"
          onClick={() => { onChange(null); setQuery(null); setOpen(false); }}
        >
          ×
        </button>
      )}
      {open && (
        <div className="rq-cbo-list" id={listId} role="listbox" aria-label={label}>
          {hits.length === 0 ? (
            <div className="rq-empty rq-cbo-empty">Ничего не нашлось</div>
          ) : (
            hits.map((x, i) => (
              <button
                key={`${x.path}#${i}`}
                type="button"
                role="option"
                aria-selected={x.path === value}
                className={"rq-cbo-row" + (i === cur ? " rq-cbo-row--on" : "")}
                title={x.path}
                // mousedown, а не click: до click поле теряет фокус, и закрытие
                // по клику мимо успевало бы снять список из-под курсора.
                onMouseDown={(e) => { e.preventDefault(); choose(x.path); }}
                onMouseEnter={() => setActive(i)}
              >
                <span className="rq-cbo-name"><PathLabel path={x.path} /></span>
                {x.has_children && <span className="rq-opt-tag">контейнер</span>}
              </button>
            ))
          )}
        </div>
      )}
    </div>
  );
}
