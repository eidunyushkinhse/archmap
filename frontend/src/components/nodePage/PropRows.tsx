// Строки свойств объекта (редизайн, направление А «Документ»). Каждая строка написана
// один раз и стоит в двух местах: в «Свойствах» страницы объекта (две колонки,
// NodeProperties) и в панели объекта редактора-карты (один столбец,
// inspector/NodeInspector). Порядок строк и колонки решает место вызова, что показать —
// сама строка. Части строки — выпадающее значение (PropDropdown), статус словом с точкой,
// подписи и пояснение принадлежности — делит с ними и окно «Новый объект» (NodeModal).
//
// Строка — пара «подпись — значение»: тихая подпись слева, значение справа. Текст любого
// значения начинается с одного x, чем бы значение ни было: кнопка-значение, поле в виде
// текста или голый текст (ui/ds.css: ds-value-btn, ds-field). У редактора значение
// правится на месте (useNodePatch: CAS, отказ — плашкой у вызывающего), у читателя — текст.
// Читателю строка без значения не рисуется (роль, технология, источник): пустое значение
// нужно только тому, кто может его задать.
import { useRef, useState } from "react";
import type { KeyboardEvent, ReactNode } from "react";
import type { AncestorRef, NodeStatus } from "../../types";
import { getNodeColors, STATUS_META } from "../graph/colors";
import { ChevronDownIcon } from "../../ui/icons";
import { noAutofill } from "../../ui/noAutofill";
import { loadErrorText } from "../../ui/loadErrorText";
import AnchorField from "../anchor/AnchorField";
import { anchorKind } from "../anchor/anchorText";
import { STATUS_ORDER, type NodeType } from "../nodeTerms";
import type { useNodePatch } from "../../pages/useNodePatch";
import { typeView } from "../element/elementView";
import { typeOptions } from "../element/typeOptions";
import { TypeValue } from "../element/ElementParts";
import { revertOnEscape } from "./revertOnEscape";
import { useFixedMenu } from "./useFixedMenu";
import { BELONGING_LABEL, BELONGING_ORDER, EXTERNAL_HINT } from "./belonging";
import "../element/element.css";
import "../../ui/ds.css";
import "./propRows.css";

type NodePatch = ReturnType<typeof useNodePatch>;

// Точка статуса: у существующего — нейтральная серая (тихий текст языка), у прочих — цвет
// статуса.
function statusDotColor(status: NodeStatus, isExternal: boolean): string {
  if (status === "existing") return "var(--c-fg-faint)";
  return getNodeColors(isExternal, 0, status).bg;
}

// Статус словом с точкой. В строке свойств точка висит слева от текста (np-status),
// чтобы текст статуса начинался с того же x, что и остальные значения. Тем же видом
// статус показан в панели объекта с другого уровня (inspector/GhostInspector).
export function StatusLabel({ status, isExternal }: { status: NodeStatus; isExternal: boolean }) {
  return (
    <span className="np-status">
      <span className="np-dot" style={{ background: statusDotColor(status, isExternal) }} aria-hidden="true" />
      {STATUS_META[status].label}
    </span>
  );
}

// Шеврон выпадающего значения: виден при наведении на строку и при фокусе.
const chevron = <span className="ds-value-chev" aria-hidden="true"><ChevronDownIcon /></span>;

// Выпадашка свойства (статус, принадлежность): значение-кнопка и меню вариантов поверх
// подложки; выбор закрывает меню, а коммит делает хук правки — только при реальном
// изменении. Escape закрывает только меню (дальше клавиша не уходит: в редакторе она
// закрыла бы панель), фокус возвращается на значение. Клавиша гасится и по умолчанию:
// в окне (нативный <dialog>, «Новый объект») иначе браузер закрыл бы всё окно.
export function PropDropdown<T extends string>({ current, options, renderOption, onPick, fixedMenu = false }: {
  current: ReactNode;
  options: readonly T[];
  renderOption: (v: T) => ReactNode;
  onPick: (v: T) => void;
  // Меню слоем position: fixed от кнопки (useFixedMenu): значение стоит в прокручиваемом
  // теле окна («Новый объект»), absolute-меню тело обрезало бы.
  fixedMenu?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const button = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLUListElement>(null);
  useFixedMenu(open && fixedMenu, button, menu, 2, () => setOpen(false));
  const onKeyDown = (e: KeyboardEvent<HTMLSpanElement>) => {
    if (e.key !== "Escape" || !open) return;
    e.preventDefault();
    e.stopPropagation();
    setOpen(false);
    button.current?.focus();
  };
  return (
    <span className="np-selwrap" onKeyDown={onKeyDown}>
      <button
        ref={button}
        type="button"
        className="ds-value-btn"
        onClick={() => setOpen((o) => !o)}
        aria-haspopup="menu"
        aria-expanded={open}
      >
        {current}
        {chevron}
      </button>
      {open && (
        <>
          <div className="ds-backdrop" onClick={() => setOpen(false)} />
          <ul ref={menu} className="np-menu ds-menu">
            {options.map((v) => (
              <li key={v}>
                <button type="button" className="ds-menu-item" onClick={() => { setOpen(false); onPick(v); }}>
                  {renderOption(v)}
                </button>
              </li>
            ))}
          </ul>
        </>
      )}
    </span>
  );
}

// Пара «подпись — значение». title — пояснение на всю строку (принадлежность).
export function Prop({ term, title, children }: { term: string; title?: string; children: ReactNode }) {
  return (
    <div className="np-prop" title={title}>
      <dt className="np-term">{term}</dt>
      <dd className="np-value">{children}</dd>
    </div>
  );
}

// Пустое значение: «загрузка» сводной технологии и пустая сводная технология системы.
const Empty = ({ text = "не указана" }: { text?: string }) => <span className="ds-empty">{text}</span>;

// Тип (Р40): одна строка из шести значений у любого объекта. Редактор меняет тип прямо
// здесь (импорт мог ошибиться в типе); невозможные пункты серые, остальные запреты — на
// сервере, отказ плашкой у вызывающего. Выбор ведёт useTypePick вызывающего: окно
// последствий рисует он. Справки «?» нет. Контейнер компонента строка не называет: на
// странице его называют крошки, в панели редактора — уровень схемы.
export function TypeProp({ patch, ancestors, isArchitect, onPick, onNavigateNode }: {
  patch: NodePatch;
  // Предки объекта от корня: по ним решается, какие типы возможны.
  ancestors: readonly AncestorRef[];
  isArchitect: boolean;
  onPick: (type: NodeType) => void;
  onNavigateNode: (id: string) => void;
}) {
  const node = patch.node;
  return (
    <Prop term="Тип">
      <TypeValue
        view={{ ...typeView(node, ancestors), container: null }}
        options={isArchitect ? typeOptions({ mode: "change", node, ancestors }) : null}
        onPick={onPick}
        onNavigateNode={onNavigateNode}
        trigger={{ className: "ds-value-btn", chevron, inline: true }}
      />
    </Prop>
  );
}

export function StatusProp({ patch, isArchitect }: { patch: NodePatch; isArchitect: boolean }) {
  const node = patch.node;
  return (
    <Prop term="Статус">
      {isArchitect ? (
        <PropDropdown
          current={<StatusLabel status={patch.status} isExternal={patch.isExternal} />}
          options={STATUS_ORDER}
          renderOption={(st) => <StatusLabel status={st} isExternal={patch.isExternal} />}
          onPick={patch.pickStatus}
        />
      ) : (
        <StatusLabel status={node.status} isExternal={node.is_external} />
      )}
    </Prop>
  );
}

// Принадлежность (до Ф3 развёртывания — «Размещение»: слово ушло площадкам). Внешность —
// относительно контура ОРГАНИЗАЦИИ (спека N2а): чужой продукт или сторона, а не «вне
// системы», границу системы выражает дерево. Подсказка снимает двусмысленность (QA
// Zabbix v4).
export function BelongingProp({ patch, isArchitect }: { patch: NodePatch; isArchitect: boolean }) {
  const belonging = patch.isExternal ? "external" : "internal";
  return (
    <Prop term="Принадлежность" title={EXTERNAL_HINT}>
      {isArchitect ? (
        <PropDropdown
          current={BELONGING_LABEL[belonging]}
          options={BELONGING_ORDER}
          renderOption={(b) => BELONGING_LABEL[b]}
          onPick={(b) => { if (b !== belonging) patch.toggleExternal(); }}
        />
      ) : (
        BELONGING_LABEL[patch.node.is_external ? "external" : "internal"]
      )}
    </Prop>
  );
}

export function RoleProp({ patch, isArchitect }: { patch: NodePatch; isArchitect: boolean }) {
  const saved = patch.node.role ?? "";
  if (!isArchitect && !saved) return null;
  return (
    <Prop term="Роль">
      {isArchitect ? (
        <input
          {...noAutofill("node-role")}
          className="ds-field"
          aria-label="Роль"
          value={patch.role}
          onChange={(e) => patch.setRole(e.target.value)}
          onBlur={patch.commitRole}
          onKeyDown={revertOnEscape(patch.role !== saved, () => patch.setRole(saved))}
          placeholder="не указана"
        />
      ) : (
        saved
      )}
    </Prop>
  );
}

// Технология (не у «Пользователя»). Система сама не запускается: её технология —
// уникальные технологии потомков, только чтение (Р15; у контейнера технология своя).
// Потомки не загрузились (techError, панель редактора) — так и сказано, с повтором:
// «не указана» было бы неправдой. Страница показывает этот отказ над свойствами.
export function TechProp({ patch, isArchitect, isSystem, techLoading, aggTech, techError = null, onTechRetry }: {
  patch: NodePatch;
  isArchitect: boolean;
  isSystem: boolean;
  techLoading: boolean;
  aggTech: string;
  techError?: unknown;
  onTechRetry?: () => void;
}) {
  const node = patch.node;
  const failed = isSystem && techError !== null;
  if (node.shape === "person") return null;
  if (!isArchitect && !(isSystem ? failed || techLoading || aggTech !== "" : !!node.technology)) return null;
  const saved = node.technology ?? "";
  return (
    <Prop term="Технология">
      {failed ? (
        <span role="alert">
          <span className="ds-empty" title={loadErrorText(techError)}>не загрузилась</span>
          {onTechRetry && <button type="button" className="np-retry" onClick={onTechRetry}>Повторить</button>}
        </span>
      ) : isSystem ? (
        techLoading ? <Empty text="загрузка" /> : aggTech !== "" ? aggTech : <Empty />
      ) : isArchitect ? (
        <input
          {...noAutofill("node-tech")}
          className="ds-field"
          aria-label="Технология"
          value={patch.technology}
          onChange={(e) => patch.setTechnology(e.target.value)}
          onBlur={patch.commitTech}
          onKeyDown={revertOnEscape(patch.technology !== saved, () => patch.setTechnology(saved))}
          placeholder="не указана"
        />
      ) : (
        saved
      )}
    </Prop>
  );
}

// Источник — чем ArchMap опознаёт объект при обновлениях из кода. Значение целиком
// открывает плавающую панель правки; «Очистить» — в ней.
export function SourceProp({ patch, isArchitect }: { patch: NodePatch; isArchitect: boolean }) {
  const node = patch.node;
  if (!isArchitect && anchorKind(node.source) === null) return null;
  return (
    <Prop term="Источник">
      <AnchorField source={node.source} isArchitect={isArchitect} onSave={patch.commitSource} />
    </Prop>
  );
}
