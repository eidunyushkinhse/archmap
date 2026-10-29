// Карточка «Свойства» страницы объекта (аудит F-5): тип, принадлежность, статус, роль,
// технология, якорь, размещение, описание — у архитектора правкой на месте (inline CAS
// через useNodePatch; размещение — окном), у наблюдателя текстом. Выпадашки типа и
// статуса — одна PropDropdown.
import { useState } from "react";
import type { ReactNode } from "react";
import type { NodeStatus } from "../../types";
import { getNodeColors, STATUS_META } from "../graph/colors";
import { ChevronDownIcon } from "../../ui/icons";
import { noAutofill } from "../../ui/noAutofill";
import AnchorField from "../anchor/AnchorField";
import PlacementRow from "./PlacementRow";
import { ELEMENT_HINT, ELEMENT_LABEL, ELEMENT_ORDER, SHAPE_LABEL, SHAPE_ORDER, STATUS_ORDER } from "../nodeTerms";
import type { useNodePatch } from "../../pages/useNodePatch";
import { elementView, useElementPick } from "../element/useElementPick";

type NodePatch = ReturnType<typeof useNodePatch>;

// Внешность — относительно контура организации, не системы (спека N2а).
const EXTERNAL_HINT =
  "Внешний — чужой продукт или чужая сторона относительно ОРГАНИЗАЦИИ (SaaS, " +
  "third-party, клиент). Свои сотрудники и свои серверы — внутренние, даже вне " +
  "границы системы: границу системы выражает дерево, а не этот флаг";

// Точка статуса: у существующего — нейтральная серая, у прочих — цвет статуса.
function statusDotColor(status: NodeStatus, isExternal: boolean): string {
  if (status === "existing") return "#9ca3af";
  return getNodeColors(isExternal, 0, status).bg;
}

function StatusLabel({ status, isExternal }: { status: NodeStatus; isExternal: boolean }) {
  return (
    <>
      <span className="np-dot" style={{ background: statusDotColor(status, isExternal) }} />
      {STATUS_META[status].label}
    </>
  );
}

// Выпадашка свойства (тип, статус): кнопка с текущим значением и меню вариантов поверх
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
        className="np-select"
        onClick={() => setOpen((o) => !o)}
        aria-haspopup="listbox"
        aria-expanded={open}
      >
        {current}
        <ChevronDownIcon />
      </button>
      {open && (
        <>
          <div className="np-backdrop" onClick={() => setOpen(false)} />
          <ul className="np-menu">
            {options.map((v) => (
              <li key={v} onClick={() => { setOpen(false); onPick(v); }}>
                {renderOption(v)}
              </li>
            ))}
          </ul>
        </>
      )}
    </span>
  );
}

export default function NodeProperties({ patch, isArchitect, isContainer, techLoading, aggTech, onPlacementChanged }: {
  patch: NodePatch;
  isArchitect: boolean;
  // Контейнер: своей технологии нет — показывается сводная технология потомков.
  isContainer: boolean;
  techLoading: boolean;
  aggTech: string;
  // Размещение записано из окна строки «Размещение» — страница перечитывает узел.
  onPlacementChanged: () => void;
}) {
  const node = patch.node;
  const shape = node.shape;
  // Элемент архитектуры (Ф5): выбор у узла с детьми, у листа и компонента — текст, у
  // «Пользователя» строки нет. Смена — с окном последствий, если они есть.
  const element = useElementPick(patch);
  const view = elementView(node, isArchitect);
  return (
    <div className="np-card">
      <h3 className="np-card-title">Свойства</h3>
      <div className="np-props">
        {/* Тип. Архитектор меняет форму прямо здесь (импорт мог ошибиться в
            типе — кейс «Monitored Hosts» с типом «Пользователь»). Запреты на
            стороне сервера: контейнером бывает только сервис, базу с описанной
            структурой не увести (спека N4а); причина отказа — плашкой выше. */}
        <span className="np-term">Тип</span>
        <span className="np-value">
          {isArchitect ? (
            <PropDropdown
              current={SHAPE_LABEL[patch.shape]}
              options={SHAPE_ORDER}
              renderOption={(sh) => SHAPE_LABEL[sh]}
              onPick={patch.pickShape}
            />
          ) : (
            SHAPE_LABEL[shape]
          )}
        </span>

        {/* Элемент архитектуры — сразу под типом. */}
        {view.kind !== "none" && (
          <>
            <span className="np-term">Элемент архитектуры</span>
            <span className="np-value">
              {view.kind === "pick" ? (
                <PropDropdown
                  current={ELEMENT_LABEL[view.value]}
                  options={ELEMENT_ORDER}
                  renderOption={(el) => (
                    <span className="np-menu-two">
                      {ELEMENT_LABEL[el]}
                      <small>{ELEMENT_HINT[el]}</small>
                    </span>
                  )}
                  onPick={element.pick}
                />
              ) : (
                view.text
              )}
            </span>
          </>
        )}

        {/* Принадлежность (до Ф3 развёртывания — «Размещение»: слово ушло площадкам).
            Внешность — относительно контура ОРГАНИЗАЦИИ (спека N2а): чужой
            продукт/сторона, а не «вне системы» — границу системы выражает дерево.
            Подсказка снимает двусмысленность (QA Zabbix v4).
            Тогл «включён» = ВНУТРЕННИЙ (решение пользователя 2026-09-04): свой
            сервис — активный синий, чужой — серый, как точка у наблюдателя ниже.
            Данные не инвертируются — только вид. */}
        <span className="np-term" title={EXTERNAL_HINT}>Принадлежность</span>
        <span className="np-value" title={EXTERNAL_HINT}>
          {isArchitect ? (
            <button type="button" className="np-toggle" onClick={patch.toggleExternal} aria-pressed={!patch.isExternal}>
              <span className={"np-switch" + (patch.isExternal ? "" : " is-on")} />
              {patch.isExternal ? "Внешний" : "Внутренний"}
            </button>
          ) : (
            <>
              <span className="np-dot" style={{ background: node.is_external ? "#9ca3af" : "#2563eb", display: "inline-block", marginRight: 6 }} />
              {node.is_external ? "Внешний" : "Внутренний"}
            </>
          )}
        </span>

        {/* Статус */}
        <span className="np-term">Статус</span>
        <span className="np-value">
          {isArchitect ? (
            <PropDropdown
              current={<StatusLabel status={patch.status} isExternal={patch.isExternal} />}
              options={STATUS_ORDER}
              renderOption={(st) => <StatusLabel status={st} isExternal={patch.isExternal} />}
              onPick={patch.pickStatus}
            />
          ) : (
            <>
              <span className="np-dot" style={{ background: statusDotColor(node.status, node.is_external), display: "inline-block", marginRight: 6 }} />
              {STATUS_META[node.status].label}
            </>
          )}
        </span>

        {/* Роль */}
        <span className="np-term">Роль</span>
        <span className="np-value">
          {isArchitect ? (
            <input
              {...noAutofill("node-page-2")}
              className="np-field"
              value={patch.role}
              onChange={(e) => patch.setRole(e.target.value)}
              onBlur={patch.commitRole}
              placeholder="сервис, БД, брокер…"
            />
          ) : (
            node.role || <span className="np-value--empty">не указана</span>
          )}
        </span>

        {/* Технология (не для персон) */}
        {shape !== "person" && (
          <>
            <span className="np-term">Технология</span>
            <span className="np-value">
              {isContainer ? (
                // Правила контейнеров: своей технологии нет — агрегированный
                // список уникальных технологий детей, только чтение.
                techLoading ? (
                  <span className="np-value--empty">загрузка…</span>
                ) : aggTech !== "" ? (
                  aggTech
                ) : (
                  <span className="np-value--empty">не указана</span>
                )
              ) : isArchitect ? (
                <input
                  {...noAutofill("node-page-3")}
                  className="np-field"
                  value={patch.technology}
                  onChange={(e) => patch.setTechnology(e.target.value)}
                  onBlur={patch.commitTech}
                  placeholder="Python, Kafka, Redis…"
                />
              ) : (
                node.technology || <span className="np-value--empty">не указана</span>
              )}
            </span>
          </>
        )}

        {/* Источник — чем ArchMap опознаёт объект при обновлениях из кода. Стоит
            среди свойств, а не в служебном углу: у ручного и агентского узла
            поведение при импорте разное, и разницу должно быть видно. */}
        {/* Терм без np-term--top: модификатор (align-self: start + отступ сверху)
            нужен textarea описания, а здесь значение — строка с текстом, и
            сетка выравнивает её с термом по базовой линии; с модификатором
            подпись уезжала ниже значения (замечание пользователя 2026-09-04). */}
        <span className="np-term">Источник</span>
        <span className="np-value">
          <AnchorField
            source={node.source}
            isArchitect={isArchitect}
            onSave={patch.commitSource}
          />
        </span>

        {/* Размещение — площадки развёртывания (Ф3 эпика развёртывания). У
            «Пользователя» размещения нет: он живёт вне системы. */}
        {shape !== "person" && (
          <PlacementRow node={node} isArchitect={isArchitect} onChanged={onPlacementChanged} />
        )}

        {/* Описание — последняя строка таблицы свойств */}
        <span className="np-term np-term--top">Описание</span>
        <span className="np-value">
          {isArchitect ? (
            <textarea
              {...noAutofill("node-page-4")}
              className="np-field np-fieldarea"
              value={patch.description}
              onChange={(e) => patch.setDescription(e.target.value)}
              onBlur={patch.commitDesc}
              placeholder="Описание объекта"
            />
          ) : (
            <span style={{ lineHeight: 1.55 }}>
              {node.description || <span className="np-value--empty">нет описания</span>}
            </span>
          )}
        </span>
      </div>
      {element.dialog}
    </div>
  );
}
