// Раздел «OpenAPI» страницы объекта (аудит F-5: вынесен из NodePage): спецификация
// объекта или «Добавить» в строке заголовка.
//
// Видимость (редизайн, направление А «Документ»): раздел рисуется, только если в нём
// есть что показать или что сделать. Подходит объекту и пуст — у редактора одна строка
// (заголовок и «Добавить»), у читателя раздела нет. Не подходит — раздела нет, пока в
// нём не лежит старое содержимое: тогда оно показано с предупреждением.
//
// По элементу архитектуры (Ф8, Р34 эпика docs/plan-c4-elements.md). API отдаёт то, что
// запускается, — контейнер:
// • контейнер (с компонентами и без) — своя спецификация, как у любого объекта без
//   вложенных; при компонентах ниже — их спецификации подгруппами с пометкой, что у
//   компонентов она не на месте, и кнопкой «Собрать с компонентов»;
// • система — своего API нет: старая собственная спецификация показана с
//   предупреждением и «Перенести документацию», документацию потомков страница системы не
//   собирает;
// • компонент — API отдаёт его контейнер: раздела нет, кроме старой собственной
//   спецификации (и спецификаций вложенных у составного компонента).
import type { Node } from "../../types";
import type { ContainerSpecGroup } from "../../pages/useContainerChildren";
import type { PageElement } from "../element/elementView";
import AddDocsMenu from "../AddDocsMenu";
import { DocRow, DocRowLabel } from "../docRow";
import Section from "../../ui/Section";
import "../../ui/ds.css";
import { DescendantGroups, SpecSplitRow } from "./DescendantGroups";
import type { DocTarget } from "./docTarget";

const MISPLACED_SPECS = "Спецификацию отдаёт контейнер целиком, у компонентов она не на месте";

export default function OpenApiSection({
  spec, element, isArchitect, allowed, legacy, groups,
  onOpen, onOpenChildSpec, onTransfer, onCollect, onNavigateNode,
}: {
  // Спецификация самого объекта (null — нет).
  spec: string | null;
  // Как страница читает объект (components/element/elementView.pageElement).
  element: PageElement;
  isArchitect: boolean;
  // OpenAPI уместен этой форме (types/shapeDocs).
  allowed: boolean;
  // Легаси: у формы спецификации быть не должно, а она есть — с предупреждением.
  legacy: boolean;
  // Спецификации компонентов по непосредственным детям (у контейнера с компонентами и у
  // составного компонента; у остальных пусто).
  groups: ContainerSpecGroup[];
  onOpen: (target: DocTarget) => void;
  // Спецификация ребёнка открывается в его CAS-контексте (страница держит базу правки).
  onOpenChildSpec: (child: Node) => void;
  // «Перенести документацию» (Р19) — только у системы: у неё своей спецификации нет;
  // у контейнера спецификация на месте, и кнопки нет (undefined).
  onTransfer?: () => void;
  // «Собрать с компонентов» — у контейнера, у компонентов которого есть спецификация.
  onCollect?: () => void;
  onNavigateNode: (id: string) => void;
}) {
  const kind = element.kind;
  const specRow = (
    <div className="ds-rows">
      <DocRow onOpen={() => onOpen({ mode: "openapi" })}>
        <DocRowLabel name="Спецификация" />
      </DocRow>
    </div>
  );

  // Компонент: API отдаёт контейнер. Раздел — только ради старых данных.
  if (kind === "component" || kind === "composite") {
    const nestedSpecs = kind === "composite" && groups.length > 0;
    if (!spec && !nestedSpecs) return null;
    return (
      <Section title="OpenAPI">
        {/* Своя спецификация у компонента — старые данные: куда её собрать. */}
        {spec && (
          <>
            <p className="np-warn">
              Спецификацию отдаёт контейнер целиком. Её можно перенести в «{element.container.name}» кнопкой «Собрать с компонентов» на его странице
            </p>
            {specRow}
          </>
        )}
        {/* Составной компонент: спецификации вложенных — с той же пометкой, что у
            контейнера; собирает их страница контейнера. */}
        {nestedSpecs && (
          <SpecGroups groups={groups} onOpenChildSpec={onOpenChildSpec} onNavigateNode={onNavigateNode} />
        )}
      </Section>
    );
  }

  // Система: своего API нет; групп потомков нет (Р34), «Добавить» тоже.
  if (kind === "system") {
    if (!spec) return null;
    return (
      <Section
        title="OpenAPI"
        actions={isArchitect && onTransfer && (
          <button type="button" className="ds-btn" onClick={onTransfer}>Перенести документацию</button>
        )}
      >
        <p className="np-warn">
          У системы осталась собственная спецификация. API отдают контейнеры, перенесите её одному из них
        </p>
        {specRow}
      </Section>
    );
  }

  // Контейнер (с компонентами и без) и прочие объекты без вложенных.
  const misplaced = kind === "container" && groups.length > 0;
  if (!spec && !misplaced && (!allowed || !isArchitect)) return null;

  // «Добавить» (когда спецификации нет): окно сразу в нужном режиме — «Вручную»
  // (редактор) или «Через ИИ-агента» (панель агента). Когда спецификация есть, её
  // обновляют в самом окне («Изменить»).
  const add = allowed && isArchitect && !spec ? (
    <AddDocsMenu
      align="right"
      groups={[
        [{ label: "Вручную", onSelect: () => onOpen({ mode: "openapi", stage: "manual" }) }],
        [{ label: "Через ИИ-агента", onSelect: () => onOpen({ mode: "openapi", stage: "agent" }) }],
      ]}
    />
  ) : null;
  // Спецификации компонентов контейнер собирает к себе (Р19).
  const collect = kind === "container" && isArchitect && onCollect ? (
    <button type="button" className="ds-btn" onClick={onCollect}>Собрать с компонентов</button>
  ) : null;

  return (
    <Section title="OpenAPI" actions={add || collect ? <>{collect}{add}</> : undefined}>
      {spec && (
        <>
          {legacy && (
            <p className="np-warn">
              OpenAPI описывает HTTP-API, который объект предоставляет сам, а у этого объекта его нет
            </p>
          )}
          {specRow}
        </>
      )}
      {/* Контейнер с компонентами: спецификации компонентов (дети и глубже) подгруппами
          по непосредственным детям — у компонентов она не на месте, контейнер собирает
          её к себе (Р19). */}
      {misplaced && (
        <SpecGroups groups={groups} onOpenChildSpec={onOpenChildSpec} onNavigateNode={onNavigateNode} />
      )}
    </Section>
  );
}

// Спецификации компонентов подгруппами по непосредственным детям: спецификация ребёнка и
// его глубоких потомков — строками под подписью с его именем.
function SpecGroups({ groups, onOpenChildSpec, onNavigateNode }: {
  groups: ContainerSpecGroup[];
  onOpenChildSpec: (child: Node) => void;
  onNavigateNode: (id: string) => void;
}) {
  return (
    <>
      <p className="np-warn">{MISPLACED_SPECS}</p>
      <DescendantGroups
        groups={groups}
        onNavigateNode={onNavigateNode}
        own={(group) => group.own && (
          <SpecSplitRow child={group.child} onOpen={onOpenChildSpec} onNavigateNode={onNavigateNode} />
        )}
        deep={(group) => group.deep}
        renderDeep={(child) => (
          <SpecSplitRow key={child.id} child={child} deep onOpen={onOpenChildSpec} onNavigateNode={onNavigateNode} />
        )}
      />
    </>
  );
}
