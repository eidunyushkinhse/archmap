// «Свойства» страницы объекта (редизайн, направление А «Документ»): две колонки пар
// «подпись — значение» сразу под описанием, без заголовка и карточки. Левая колонка —
// тип, статус, принадлежность, роль; правая — технология, источник, размещение. Порядок
// в разметке — порядок обхода Tab: сначала левая колонка, потом правая. У архитектора
// правка на месте по клику на значении (inline CAS через useNodePatch; размещение —
// окном), у читателя текст. Текст любого значения начинается с одного x: элементы
// управления выглядят текстом (ui/ds.css: ds-value-btn, ds-field). Строка «Тип» — общий
// рендер с инспектором редактора (element/TypeValue), вид кнопки задаёт место вызова.
import { useState } from "react";
import type { ReactNode } from "react";
import type { AncestorRef, Node, NodeStatus } from "../../types";
import { getNodeColors, STATUS_META } from "../graph/colors";
import { ChevronDownIcon } from "../../ui/icons";
import { noAutofill } from "../../ui/noAutofill";
import AnchorField from "../anchor/AnchorField";
import PlacementRow from "./PlacementRow";
import { STATUS_ORDER } from "../nodeTerms";
import type { useNodePatch } from "../../pages/useNodePatch";
import { useTypePick } from "../element/useTypePick";
import { pageElement, typeView } from "../element/elementView";
import { typeOptions } from "../element/typeOptions";
import { TypeValue } from "../element/ElementParts";
import "../element/element.css";
import "../../ui/ds.css";

type NodePatch = ReturnType<typeof useNodePatch>;

// Внешность — относительно контура организации, не системы (спека N2а).
const EXTERNAL_HINT =
  "Внешний объект принадлежит не вам: SaaS, сторонний сервис, клиент. Свои сотрудники и " +
  "серверы внутренние, даже если они вне системы. Границу системы показывает вложенность " +
  "объектов.";

// Принадлежность — выпадашкой из двух пунктов, как статус (переключатель с меняющейся
// подписью читался хуже).
type Belonging = "internal" | "external";
const BELONGING_ORDER: readonly Belonging[] = ["internal", "external"];
const BELONGING_LABEL: Record<Belonging, string> = { internal: "Внутренний", external: "Внешний" };

// Точка статуса: у существующего — нейтральная серая, у прочих — цвет статуса.
function statusDotColor(status: NodeStatus, isExternal: boolean): string {
  if (status === "existing") return "#9ca3af";
  return getNodeColors(isExternal, 0, status).bg;
}

// Статус словом с точкой. В строке свойств точка висит слева от текста (np-status),
// чтобы текст статуса начинался с того же x, что и остальные значения.
function StatusLabel({ status, isExternal }: { status: NodeStatus; isExternal: boolean }) {
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
// изменении.
function PropDropdown<T extends string>({ current, options, renderOption, onPick }: {
  current: ReactNode;
  options: readonly T[];
  renderOption: (v: T) => ReactNode;
  onPick: (v: T) => void;
}) {
  const [open, setOpen] = useState(false);
  return (
    <span className="np-selwrap">
      <button
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
          <div className="np-backdrop" onClick={() => setOpen(false)} />
          <ul className="np-menu ds-menu">
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
function Prop({ term, title, children }: { term: string; title?: string; children: ReactNode }) {
  return (
    <div className="np-prop" title={title}>
      <dt className="np-term">{term}</dt>
      <dd className="np-value">{children}</dd>
    </div>
  );
}

// Пустое значение у читателя.
const Empty = ({ text = "не указана" }: { text?: string }) => <span className="ds-empty">{text}</span>;

export default function NodeProperties({
  patch, ancestors, isArchitect, isSystem, techLoading, aggTech, containerSites, onNavigateNode, onPlacementChanged,
}: {
  patch: NodePatch;
  // Предки объекта от корня (крошки страницы): контейнер компонента для ссылки.
  ancestors: readonly AncestorRef[];
  isArchitect: boolean;
  // Система: своей технологии нет — показывается сводная технология потомков (Р15).
  isSystem: boolean;
  techLoading: boolean;
  aggTech: string;
  // Площадки контейнера компонента (строка «Размещение»); null — не компонент или
  // контейнер ещё грузится.
  containerSites: Node["sites"] | null;
  // Переход на страницу другого объекта (имя контейнера у компонента).
  onNavigateNode: (id: string) => void;
  // Размещение записано из окна строки «Размещение» — страница перечитывает узел.
  onPlacementChanged: () => void;
}) {
  const node = patch.node;
  const shape = node.shape;
  // Тип (Р40): система ↔ контейнер — смена элемента с окном последствий, если они есть;
  // база, брокер, «Пользователь» — смена формы с правилами сервера.
  const typePick = useTypePick(patch);
  const belonging: Belonging = patch.isExternal ? "external" : "internal";
  return (
    <>
      <div className="np-props">
        {/* ── Левая колонка: тип, статус, принадлежность, роль ── */}
        <dl className="np-props-col">
          {/* Тип (Р40): одна строка из шести значений у любого объекта. Архитектор меняет
              тип прямо здесь (импорт мог ошибиться в типе); невозможные пункты серые,
              остальные запреты — на сервере, отказ плашкой выше. Справка «?» о типах
              живёт в инспекторе редактора: на странице подпись без значков. */}
          <Prop term="Тип">
            <TypeValue
              view={typeView(node, ancestors)}
              options={isArchitect ? typeOptions({ mode: "change", node, ancestors }) : null}
              onPick={typePick.pick}
              onNavigateNode={onNavigateNode}
              trigger={{ className: "ds-value-btn", chevron, inline: true }}
            />
          </Prop>

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

          {/* Принадлежность (до Ф3 развёртывания — «Размещение»: слово ушло площадкам).
              Внешность — относительно контура ОРГАНИЗАЦИИ (спека N2а): чужой
              продукт/сторона, а не «вне системы» — границу системы выражает дерево.
              Подсказка снимает двусмысленность (QA Zabbix v4). */}
          <Prop term="Принадлежность" title={EXTERNAL_HINT}>
            {isArchitect ? (
              <PropDropdown
                current={BELONGING_LABEL[belonging]}
                options={BELONGING_ORDER}
                renderOption={(b) => BELONGING_LABEL[b]}
                onPick={(b) => { if (b !== belonging) patch.toggleExternal(); }}
              />
            ) : (
              BELONGING_LABEL[node.is_external ? "external" : "internal"]
            )}
          </Prop>

          <Prop term="Роль">
            {isArchitect ? (
              <input
                {...noAutofill("node-page-2")}
                className="ds-field"
                aria-label="Роль"
                value={patch.role}
                onChange={(e) => patch.setRole(e.target.value)}
                onBlur={patch.commitRole}
                placeholder="не указана"
              />
            ) : (
              node.role || <Empty />
            )}
          </Prop>
        </dl>

        {/* ── Правая колонка: технология, источник, размещение ── */}
        <dl className="np-props-col">
          {/* Технология (не для персон) */}
          {shape !== "person" && (
            <Prop term="Технология">
              {isSystem ? (
                // Система сама не запускается: её технология — уникальные технологии
                // потомков, только чтение (Р15; у контейнера технология своя).
                techLoading ? <Empty text="загрузка" /> : aggTech !== "" ? aggTech : <Empty />
              ) : isArchitect ? (
                <input
                  {...noAutofill("node-page-3")}
                  className="ds-field"
                  aria-label="Технология"
                  value={patch.technology}
                  onChange={(e) => patch.setTechnology(e.target.value)}
                  onBlur={patch.commitTech}
                  placeholder="не указана"
                />
              ) : (
                node.technology || <Empty />
              )}
            </Prop>
          )}

          {/* Источник — чем ArchMap опознаёт объект при обновлениях из кода. Значение
              целиком открывает редактор источника; «Очистить» и справка — в нём. */}
          <Prop term="Источник">
            <AnchorField
              source={node.source}
              isArchitect={isArchitect}
              onSave={patch.commitSource}
              variant="page"
            />
          </Prop>

          {/* Размещение — площадки развёртывания (Ф3 эпика развёртывания). У
              «Пользователя» размещения нет: он живёт вне системы. */}
          {shape !== "person" && (
            <PlacementRow
              node={node}
              element={pageElement(node, ancestors)}
              containerSites={containerSites}
              isArchitect={isArchitect}
              onChanged={onPlacementChanged}
            />
          )}
        </dl>
      </div>
      {typePick.dialog}
    </>
  );
}
