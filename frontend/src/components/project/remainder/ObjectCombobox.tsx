// Выбор объекта слитого дерева КОМБОБОКСОМ (П4 v2 приёмки): само поле и есть
// фильтр — человек начинает печатать имя, и список под полем сужается. Прежняя
// панель «раскрой список, потом найди в нём поле поиска» была лишним шагом там,
// где нужен один жест.
//
// Список — слой position: fixed от прямоугольника поля (фаза 8б редизайна; приём тот же,
// что у ui/InfoPopover): absolute-список внутри прокручиваемого тела окна обрезался им и
// раздувал прокрутку, а у нижней строки формы не был виден вовсе. Слой остаётся потомком
// поля и окна: окно — нативный <dialog> в верхнем слое, портал в body оказался бы под ним,
// а щелчок по строке списка должен оставаться щелчком «внутри» (закрытие по щелчку мимо).
// Место — под полем, если снизу хватает места, иначе над ним; высота не больше 320px и
// свободного места до края экрана без 12px, ширина не меньше поля и 320px. Пока список
// открыт, он СЛЕДУЕТ за полем: прокрутка тела окна и смена размера окна браузера
// пересчитывают его место. Поле ушло из видимой части прокручиваемого предка (тела окна)
// целиком — список закрывается: иначе он висел бы поверх шапки или подвала окна.
//
// Щелчок по полю открывает список и тогда, когда поле уже в фокусе (после Escape или
// выбора соседа): «выбрал, передумал, щёлкнул, чтобы сменить».
import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { ComponentOut } from "../../../types";
import { lastSegment, nestedTag } from "./questionText";
import { PathLabel } from "./Option";
import { noAutofill } from "../../../ui/noAutofill";
import "../../../ui/ds.css";
import "./remainder.css";

interface Props {
  /** Объекты, из которых выбирают (левый объект строки сюда не попадает). */
  items: ComponentOut[];
  value: string | null;
  onChange: (path: string | null) => void;
  /** Подпись поля для скринридера — в строке формы видимой подписи нет. */
  label: string;
}

// Зазор от поля, поле от края экрана, предел высоты и наименьшая ширина списка.
const GAP = 4;
const EDGE = 12;
const MAX_H = 320;
const MIN_W = 320;

/** Ближайший прокручиваемый предок (тело окна); null — прокручивается только экран. */
function scrollParent(el: HTMLElement | null): HTMLElement | null {
  for (let e = el?.parentElement ?? null; e !== null; e = e.parentElement) {
    if (/(auto|scroll|overlay)/.test(getComputedStyle(e).overflowY)) return e;
  }
  return null;
}

export default function ObjectCombobox({ items, value, onChange, label }: Props) {
  const listId = useId();
  const wrapRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  // Подсветку сдвинула клавиатура: только тогда подсвеченная строка прокручивается в вид
  // (наведение мышью список не двигает — иначе он ехал бы из-под курсора).
  const byKeys = useRef(false);
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

  // Место списка от поля. Пишется прямо в style по ref, а не в стейт: это измерение, а не
  // производное состояние, и лишний рендер на каждый кадр прокрутки ему не нужен.
  const place = useCallback(() => {
    const list = listRef.current;
    const inp = inputRef.current;
    if (list === null || inp === null) return;
    const r = inp.getBoundingClientRect();
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const width = Math.min(Math.max(r.width, MIN_W), vw - EDGE * 2);
    const left = Math.max(EDGE, Math.min(r.left, vw - EDGE - width));
    // scrollHeight — содержимое с полями без ограничения высоты; +2 на рамки.
    const need = Math.min(MAX_H, list.scrollHeight + 2);
    const below = vh - r.bottom - GAP - EDGE;
    const above = r.top - GAP - EDGE;
    const down = need <= below || below >= above;
    list.style.left = `${left}px`;
    list.style.width = `${width}px`;
    list.style.maxHeight = `${Math.max(0, Math.min(MAX_H, down ? below : above))}px`;
    // Над полем список держится нижним краем: сужение фильтром не отрывает его от поля.
    list.style.top = down ? `${r.bottom + GAP}px` : "auto";
    list.style.bottom = down ? "auto" : `${vh - r.top + GAP}px`;
  }, []);

  // До отрисовки: список не мигает в неверном месте, а при сужении фильтром место
  // пересчитывается по новой высоте.
  useLayoutEffect(() => {
    if (open) place();
  }, [open, hits, place]);

  // Список следует за полем: прокрутка тела окна (capture — до window она не всплывает)
  // и смена размера окна браузера. Прокрутка самого списка место не меняет, а пересчёт
  // на ней безвреден. Поле целиком ушло из видимой части прокручиваемого предка —
  // список закрывается; пока поле видно хотя бы краем, он следует за ним.
  useEffect(() => {
    if (!open) return;
    const onScroll = () => {
      const inp = inputRef.current;
      const box = scrollParent(wrapRef.current);
      if (inp !== null && box !== null) {
        const r = inp.getBoundingClientRect();
        const b = box.getBoundingClientRect();
        if (r.bottom <= b.top || r.top >= b.bottom) {
          setOpen(false);
          setQuery(null);
          return;
        }
      }
      place();
    };
    window.addEventListener("scroll", onScroll, true);
    window.addEventListener("resize", place);
    return () => {
      window.removeEventListener("scroll", onScroll, true);
      window.removeEventListener("resize", place);
    };
  }, [open, place]);

  // Подсвеченная клавиатурой строка всегда видна в списке.
  useEffect(() => {
    if (!open || !byKeys.current) return;
    byKeys.current = false;
    listRef.current?.querySelector<HTMLElement>(".rq-cbo-row--on")?.scrollIntoView({ block: "nearest" });
  }, [open, cur]);

  // Клик мимо закрывает список — и заодно гарантирует «открыт только один за раз».
  // Список — потомок обёртки, поэтому щелчок по его строке щелчком мимо не считается.
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
      byKeys.current = true;
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
        {...noAutofill("object-combobox-1")}
        ref={inputRef}
        className="ds-input rq-cbo-inp"
        role="combobox"
        aria-expanded={open}
        aria-controls={listId}
        aria-autocomplete="list"
        aria-label={label}
        // Путь длиннее поля обрезается визуально — title отдаёт его целиком.
        title={value ?? undefined}
        placeholder="Имя объекта"
        value={query ?? value ?? ""}
        onChange={(e) => { setQuery(e.target.value); setActive(0); setOpen(true); }}
        onFocus={() => setOpen(true)}
        // Поле уже в фокусе (после Escape или выбора) — focus не придёт, открывает щелчок.
        // Открытый список щелчок не трогает.
        onClick={() => setOpen(true)}
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
        <div className="rq-cbo-list" id={listId} role="listbox" aria-label={label} ref={listRef}>
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
                onMouseEnter={() => { byKeys.current = false; setActive(i); }}
              >
                <span className="rq-cbo-name"><PathLabel path={x.path} /></span>
                {x.has_children && <span className="rq-opt-tag">{nestedTag(x)}</span>}
              </button>
            ))
          )}
        </div>
      )}
    </div>
  );
}
