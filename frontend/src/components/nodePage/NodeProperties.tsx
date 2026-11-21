// «Свойства» страницы объекта (редизайн, направление А «Документ»): две колонки пар
// «подпись — значение» сразу под описанием, без заголовка и карточки. Левая колонка —
// тип, статус, принадлежность, роль; правая — технология, источник, размещение. Порядок
// в разметке — порядок обхода Tab: сначала левая колонка, потом правая. Сами строки —
// общие с панелью объекта в редакторе-карте (PropRows): правка на месте у редактора,
// текст у читателя, строка без значения читателю не рисуется. Своё у страницы —
// раскладка в две колонки и строка «Размещение».
import type { AncestorRef, Node } from "../../types";
import PlacementRow from "./PlacementRow";
import { BelongingProp, RoleProp, SourceProp, StatusProp, TechProp, TypeProp } from "./PropRows";
import type { useNodePatch } from "../../pages/useNodePatch";
import { useTypePick } from "../element/useTypePick";
import { pageElement } from "../element/elementView";

type NodePatch = ReturnType<typeof useNodePatch>;

export default function NodeProperties({
  patch, ancestors, isArchitect, isSystem, techLoading, aggTech, containerSites, onNavigateNode, onPlacementChanged,
}: {
  patch: NodePatch;
  // Предки объекта от корня (крошки страницы): какие типы возможны.
  ancestors: readonly AncestorRef[];
  isArchitect: boolean;
  // Система: своей технологии нет — показывается сводная технология потомков (Р15).
  isSystem: boolean;
  techLoading: boolean;
  aggTech: string;
  // Площадки контейнера компонента (строка «Размещение»); null — не компонент или
  // контейнер ещё грузится.
  containerSites: Node["sites"] | null;
  // Переход на страницу другого объекта (строка «Тип»).
  onNavigateNode: (id: string) => void;
  // Размещение записано из окна строки «Размещение» — страница перечитывает узел.
  onPlacementChanged: () => void;
}) {
  const node = patch.node;
  // Тип (Р40): система ↔ контейнер — смена элемента с окном последствий, если они есть;
  // база, брокер, «Пользователь» — смена формы с правилами сервера.
  const typePick = useTypePick(patch);
  return (
    <>
      <div className="np-props">
        {/* ── Левая колонка: тип, статус, принадлежность, роль ── */}
        <dl className="np-props-col">
          <TypeProp patch={patch} ancestors={ancestors} isArchitect={isArchitect}
            onPick={typePick.pick} onNavigateNode={onNavigateNode} />
          <StatusProp patch={patch} isArchitect={isArchitect} />
          <BelongingProp patch={patch} isArchitect={isArchitect} />
          <RoleProp patch={patch} isArchitect={isArchitect} />
        </dl>

        {/* ── Правая колонка: технология, источник, размещение ── */}
        <dl className="np-props-col">
          <TechProp patch={patch} isArchitect={isArchitect} isSystem={isSystem}
            techLoading={techLoading} aggTech={aggTech} />
          <SourceProp patch={patch} isArchitect={isArchitect} />

          {/* Размещение — площадки развёртывания (Ф3 эпика развёртывания). У
              «Пользователя» размещения нет: он живёт вне системы. */}
          {node.shape !== "person" && (
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
