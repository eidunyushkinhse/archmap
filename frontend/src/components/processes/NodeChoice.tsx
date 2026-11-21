// Объект схемы участника в окне импорта процесса (редизайн, фаза 3в): значение-кнопка и
// плавающая панель под ней с поиском и списком. Первым пунктом «Без объекта», дальше
// кандидаты превью (совпадения по имени), ниже остальные объекты проекта по имени. Какие
// объекты годятся и откуда они берутся — schemaNodes (тот же источник и то же правило,
// что у «Добавить участника»); грузит их окно один раз, при первом открытии панели.
//
// Панель — обычный блок внутри окна (вложенный <dialog> нельзя), но position: fixed с
// координатами от кнопки: прокрутка содержимого окна её не обрезает. Escape и Enter
// панель гасит сама (preventDefault и stopPropagation): Escape иначе закрыл бы всё окно
// (нативный cancel), Enter подтвердил бы его. Закрытие любым путём возвращает фокус на
// кнопку-значение.
import { useEffect, useId, useRef, useState } from "react";
import type { CSSProperties, KeyboardEvent } from "react";
import type { Node as SchemaNode } from "../../types";
import { CheckIcon, ChevronDownIcon } from "../../ui/icons";
import { noAutofill } from "../../ui/noAutofill";
import type { Participant } from "./importIssues";
import type { SchemaNodes } from "./schemaNodes";

interface Props {
  participant: Participant;
  // Выбранный объект: id узла или пустая строка (без объекта).
  value: string;
  // Объекты, выбранные другим участникам этого черновика: второй раз не предлагаются.
  taken: ReadonlySet<string>;
  schema: SchemaNodes;
  onChoose: (nodeId: string) => void;
}

interface Entry {
  id: string;
  name: string;
  label: string;
  candidate: boolean;
}

/** Пункт списка панели. id "" — «Без объекта». */
interface ChoiceOption {
  id: string;
  label: string;
  // Первый объект не из кандидатов: над ним черта, отделяющая кандидатов.
  sep: boolean;
}

const NONE = "Без объекта";

/** Все объекты для выбора: кандидаты превью, затем остальные объекты проекта по имени.
 *  У тёзок в скобках родитель: иначе одинаковые строки не различить. */
function entriesOf(p: Participant, nodes: SchemaNode[] | null): Entry[] {
  const count = new Map<string, number>();
  for (const n of nodes ?? p.candidates) count.set(n.name, (count.get(n.name) ?? 0) + 1);
  const label = (name: string, parent: string | null | undefined) =>
    (count.get(name) ?? 0) > 1 && parent ? `${name} (${parent})` : name;

  const out: Entry[] = p.candidates.map((c) => ({ id: c.id, name: c.name, label: label(c.name, c.parent_name), candidate: true }));
  if (!nodes) return out;
  const cand = new Set(p.candidates.map((c) => c.id));
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const rest = nodes
    .filter((n) => !cand.has(n.id))
    .map((n) => ({
      id: n.id,
      name: n.name,
      label: label(n.name, n.parent_id ? byId.get(n.parent_id)?.name : null),
      candidate: false,
    }))
    .sort((a, b) => a.label.localeCompare(b.label, "ru"));
  return [...out, ...rest];
}

/** Пункты панели под запрос: «Без объекта» всегда первым, занятые другими участниками
 *  объекты не предлагаются (свой выбранный — предлагается). */
function choiceOptions(
  entries: Entry[], taken: ReadonlySet<string>, value: string, query: string,
): ChoiceOption[] {
  const q = query.trim().toLocaleLowerCase("ru");
  const out: ChoiceOption[] = [{ id: "", label: NONE, sep: false }];
  let shownCandidate = false;
  let sepDone = false;
  for (const e of entries) {
    if (taken.has(e.id) && e.id !== value) continue;
    if (q && !e.name.toLocaleLowerCase("ru").includes(q)) continue;
    const sep = !e.candidate && shownCandidate && !sepDone;
    if (e.candidate) shownCandidate = true;
    else sepDone = true;
    out.push({ id: e.id, label: e.label, sep });
  }
  return out;
}

// Геометрия панели: ширина, зазор до кнопки, поле до края окна браузера, высота.
const PANEL_W = 320;
const GAP = 4;
const EDGE = 16;
const MIN_BELOW = 220;
const MAX_H = 360;

/** Место панели у кнопки: под ней, а если снизу тесно и сверху просторнее — над ней. */
function place(btn: HTMLElement): CSSProperties {
  const r = btn.getBoundingClientRect();
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const left = Math.max(EDGE, Math.min(r.left - 4, vw - PANEL_W - EDGE));
  const below = vh - r.bottom - GAP - EDGE;
  const above = r.top - GAP - EDGE;
  if (below >= MIN_BELOW || below >= above) {
    return { left, top: r.bottom + GAP, maxHeight: Math.min(MAX_H, below) };
  }
  return { left, bottom: vh - r.top + GAP, maxHeight: Math.min(MAX_H, above) };
}

export default function NodeChoice({ participant: p, value, taken, schema, onChoose }: Props) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const [pos, setPos] = useState<CSSProperties>({});
  const btnRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLUListElement>(null);
  const uid = useId();
  const listId = `${uid}-list`;

  const entries = entriesOf(p, schema.nodes);
  const options = choiceOptions(entries, taken, value, query);
  const current = value ? entries.find((e) => e.id === value)?.label ?? null : null;
  // Пункт под клавиатурой; список мог стать короче (догрузились объекты, сузился поиск).
  const act = Math.min(active, options.length - 1);

  function openPanel() {
    const btn = btnRef.current;
    if (!btn) return;
    schema.request();
    setPos(place(btn));
    setQuery("");
    setActive(Math.max(0, choiceOptions(entries, taken, value, "").findIndex((o) => o.id === value)));
    setOpen(true);
  }

  function close() {
    setOpen(false);
    btnRef.current?.focus();
  }

  function choose(o: ChoiceOption) {
    if (o.id !== value) onChoose(o.id);
    close();
  }

  function onQuery(q: string) {
    setQuery(q);
    // Набранное имя — сразу на первом найденном объекте: Enter выбирает его.
    setActive(choiceOptions(entries, taken, value, q).length > 1 ? 1 : 0);
  }

  function onKey(e: KeyboardEvent<HTMLDivElement>) {
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      close();
    } else if (e.key === "Enter") {
      e.preventDefault();
      e.stopPropagation();
      const o = options[act];
      if (o) choose(o);
    } else if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      const step = e.key === "ArrowDown" ? 1 : -1;
      setActive(Math.max(0, Math.min(options.length - 1, act + step)));
    } else if (e.key === "Tab") {
      // Уход Tab-ом — то же, что Escape: фокус на значение, дальше Tab идёт как обычно.
      e.preventDefault();
      close();
    }
  }

  // Пункт под клавиатурой — в видимой части списка (прокрутка только самого списка).
  useEffect(() => {
    const list = listRef.current;
    const el = list?.querySelector<HTMLElement>("[data-active]");
    if (!list || !el) return;
    if (el.offsetTop < list.scrollTop) list.scrollTop = el.offsetTop;
    else if (el.offsetTop + el.offsetHeight > list.scrollTop + list.clientHeight) {
      list.scrollTop = el.offsetTop + el.offsetHeight - list.clientHeight;
    }
  }, [open, act]);

  // Окно прокрутили или изменили размер браузера: панель едет за кнопкой.
  useEffect(() => {
    if (!open) return;
    const follow = (e: Event) => {
      if (e.target instanceof Node && panelRef.current?.contains(e.target)) return; // прокрутка самого списка
      if (btnRef.current) setPos(place(btnRef.current));
    };
    window.addEventListener("resize", follow);
    document.addEventListener("scroll", follow, true);
    return () => {
      window.removeEventListener("resize", follow);
      document.removeEventListener("scroll", follow, true);
    };
  }, [open]);

  const nothing = schema.nodes !== null && options.length === 1 && query.trim() !== "";

  return (
    <span className="pim-choice">
      <button
        ref={btnRef}
        type="button"
        className="ds-value-btn pim-choice-btn"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={`${p.name}: ${current ?? "Выбрать объект"}`}
        onClick={() => (open ? close() : openPanel())}
        onKeyDown={(e) => {
          if (e.key === "ArrowDown" && !open) { e.preventDefault(); openPanel(); }
        }}
      >
        {current !== null
          ? <span className="pim-choice-text">{current}</span>
          : <span className="ds-empty">Выбрать объект</span>}
        <span className="ds-value-chev"><ChevronDownIcon /></span>
      </button>
      {open && (
        <>
          {/* Клик мимо: закрыть, не уводя фокус (preventDefault), и вернуть его на кнопку. */}
          <div className="pim-pop-backdrop" onMouseDown={(e) => { e.preventDefault(); close(); }} />
          <div
            ref={panelRef}
            className="pim-pop"
            style={pos}
            role="group"
            aria-label={`Объект для «${p.name}»`}
            onKeyDown={onKey}
          >
            <input
              {...noAutofill("process-import-node")}
              className="ds-input"
              autoFocus
              value={query}
              placeholder="Поиск по имени"
              role="combobox"
              aria-label="Поиск объекта"
              aria-expanded
              aria-controls={listId}
              aria-autocomplete="list"
              aria-activedescendant={`${uid}-${act}`}
              onChange={(e) => onQuery(e.target.value)}
            />
            {/* mousedown гасится: фокус остаётся в поле поиска, клик выбирает пункт. */}
            <ul
              ref={listRef}
              id={listId}
              role="listbox"
              aria-label="Объекты схемы"
              className="pim-pop-list"
              onMouseDown={(e) => e.preventDefault()}
            >
              {options.map((o, i) => (
                <li
                  key={o.id || "none"}
                  id={`${uid}-${i}`}
                  role="option"
                  aria-selected={o.id === value}
                  data-active={i === act || undefined}
                  className={"pim-pop-opt"
                    + (i === act ? " is-active" : "")
                    + (o.id === "" ? " pim-pop-opt--none" : "")
                    + (o.sep ? " pim-pop-opt--sep" : "")}
                  // Указатель ведёт подсветку сам (одна подсвеченная строка на мышь и
                  // клавиатуру); именно move, а не enter: список, прокрученный
                  // стрелками под неподвижным указателем, подсветку не перехватывает.
                  onMouseMove={() => { if (i !== act) setActive(i); }}
                  onClick={() => choose(o)}
                >
                  <span className="pim-pop-label">{o.label}</span>
                  {o.id === value && <span className="pim-pop-check"><CheckIcon /></span>}
                </li>
              ))}
            </ul>
            {schema.error
              ? <p className="pim-pop-note pim-pop-note--err">{schema.error}</p>
              : schema.nodes === null
                ? <p className="pim-pop-note">Загрузка</p>
                : nothing && <p className="pim-pop-note">Ничего не найдено</p>}
          </div>
        </>
      )}
    </span>
  );
}
