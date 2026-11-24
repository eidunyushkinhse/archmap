// Панель объекта в редакторе-карте (редизайн, направление А «Документ»): те же строки,
// что «Свойства» страницы объекта (nodePage/PropRows), в один столбец. Сверху вниз:
// заголовок (значок формы, название, «Открыть страницу объекта», «Закрыть»), описание,
// строки «Тип», «Принадлежность», «Статус», «Роль», «Технология», «Источник», внизу у
// редактора — «Удалить объект». Читатель видит только строки со значением.
//
// Правка на месте коммитится по уходу с поля (тексты) или сразу (выбор) с CAS и
// 409-ресинком — тот же хук, что на странице объекта. Успешная правка ложится в Undo
// редактора: хук отдаёт узел ДО правки вторым аргументом. Значения полей сбрасываются на
// смену выбора: ObjectInspector монтирует панель с key=node.id. Документация (схемы
// логики, OpenAPI) здесь не управляется — на страницу объекта ведёт кнопка заголовка.
import { useMemo, useState } from "react";
import type { AncestorRef, DeletionSnapshot, Node } from "../../types";
import { treeNesting } from "../../types";
import { ShapeGlyph } from "../nodeTree.shared";
import NodeDeleteConfirm from "../NodeDeleteConfirm";
import DescriptionField from "../nodePage/DescriptionField";
import { BelongingProp, RoleProp, SourceProp, StatusProp, TechProp, TypeProp } from "../nodePage/PropRows";
import { revertOnEscape } from "../nodePage/revertOnEscape";
import { aggregateTech, useDescendants } from "../../pages/useContainerChildren";
import { useNodePatch } from "../../pages/useNodePatch";
import { useTypePick } from "../element/useTypePick";
import { pageElement } from "../element/elementView";
import { noAutofill } from "../../ui/noAutofill";
import PanelHead from "./PanelHead";
import "../../ui/ds.css";
import "./panel.css";

interface Props {
  node: Node;
  // Предки узла от корня (крошки уровня и раскрытые рамки над ним): какие типы возможны.
  ancestors: readonly AncestorRef[];
  isArchitect: boolean;
  // Тот же обработчик, что у окна: кладёт правку в Undo/Redo. before — узел ДО правки.
  onNodeSaved: (saved: Node, isCreate: boolean, before?: Node) => void;
  onNodeDeleted: (id: string, snapshot: DeletionSnapshot) => void;
  // «Открыть страницу объекта» в заголовке.
  onNavigateNode: (nodeId: string) => void;
  onClose: () => void;
}

export default function NodeInspector({ node: initial, ancestors, isArchitect, onNodeSaved, onNodeDeleted, onNavigateNode, onClose }: Props) {
  // Конфликт версий (409: правка не применилась, данные обновлены с сервера) и отказ с
  // причиной (400: смена типа у узла с детьми, у базы с описанной структурой) — плашками.
  const patch = useNodePatch(initial, (saved, before) => onNodeSaved(saved, false, before));
  const node = patch.node;
  // Тип (Р40): система ↔ контейнер — смена элемента с окном последствий, если они есть;
  // база, брокер, «Пользователь» — смена формы с правилами сервера.
  const typePick = useTypePick(patch);
  const [confirming, setConfirming] = useState(false);
  // Сводная технология потомков, только чтение — у системы (Р15), как на странице, в том
  // числе у пустой (Р39). База или брокер с вложенными (данные до проверки формы родителя
  // на сервере) остаются листом и технологию не сворачивают — своя полем. Потомки
  // грузятся, только если они есть.
  const isSystem = node.shape === "service" && pageElement(node, ancestors).kind === "system";
  const loadKids = isSystem && node.has_children;
  const { descendants, error: techError, reload: reloadTech } = useDescendants(node.id, loadKids);
  const aggTech = useMemo(() => (descendants ? aggregateTech(descendants) : ""), [descendants]);
  const techLoading = loadKids && descendants === null && techError === null;

  const title = isArchitect ? (
    // Название растёт по тексту и переносится; Enter и уход с поля сохраняют, Escape
    // возвращает прежнее.
    <span className="ds-grow ip-name" data-value={patch.name}>
      <textarea
        {...noAutofill("node-name")}
        className="ds-grow-input"
        rows={1}
        aria-label="Название"
        value={patch.name}
        onChange={(e) => patch.setName(e.target.value.replace(/\n/g, " "))}
        onBlur={patch.commitName}
        onKeyDown={(e) => {
          if (e.key === "Enter" && !e.nativeEvent.isComposing) { e.preventDefault(); e.currentTarget.blur(); return; }
          revertOnEscape(patch.name !== node.name, () => patch.setName(node.name))(e);
        }}
      />
    </span>
  ) : (
    <h2 className="ip-title">{node.name}</h2>
  );

  return (
    <>
      <PanelHead
        glyph={<ShapeGlyph nesting={treeNesting(node)} shape={node.shape} />}
        title={title}
        // У «Пользователя» документации нет — и страницы в панели тоже.
        onOpenPage={node.shape !== "person" ? () => onNavigateNode(node.id) : undefined}
        onClose={onClose}
      />

      <DescriptionField
        value={isArchitect ? patch.description : (node.description ?? "")}
        editable={isArchitect}
        onChange={patch.setDescription}
        onCommit={patch.commitDesc}
        saved={node.description ?? ""}
      />

      {patch.conflict && <p className="ds-warn">{patch.conflict}</p>}
      {patch.error && <p className="ds-warn">{patch.error}</p>}

      <dl className="ip-props">
        <TypeProp patch={patch} ancestors={ancestors} isArchitect={isArchitect}
          onPick={typePick.pick} onNavigateNode={onNavigateNode} />
        <BelongingProp patch={patch} isArchitect={isArchitect} />
        <StatusProp patch={patch} isArchitect={isArchitect} />
        <RoleProp patch={patch} isArchitect={isArchitect} />
        <TechProp patch={patch} isArchitect={isArchitect} isSystem={isSystem}
          techLoading={techLoading} aggTech={aggTech} techError={techError} onTechRetry={reloadTech} />
        <SourceProp patch={patch} isArchitect={isArchitect} />
      </dl>

      {isArchitect && (
        <button type="button" className="ip-delete" onClick={() => setConfirming(true)}>Удалить объект</button>
      )}

      {typePick.dialog}

      {confirming && (
        <NodeDeleteConfirm
          node={node}
          onCancel={() => setConfirming(false)}
          onDeleted={(id, snapshot) => { setConfirming(false); onNodeDeleted(id, snapshot); }}
        />
      )}
    </>
  );
}
