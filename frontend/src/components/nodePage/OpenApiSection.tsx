// Секция «OpenAPI» страницы объекта (аудит F-5: вынесена из NodePage): спецификация
// объекта или меню «+ Добавить».
//
// По элементу архитектуры (Ф8, Р34 эпика docs/plan-c4-elements.md). API отдаёт то, что
// запускается, — контейнер:
// • контейнер (с компонентами и без) — своя спецификация, как у любого объекта без
//   вложенных; при компонентах ниже — их спецификации группами с пометкой, что у
//   компонентов она не на месте, и кнопкой «Собрать с компонентов»;
// • система — своего API нет: старая собственная спецификация показана с
//   предупреждением и «Перенести документацию», документацию потомков страница системы не
//   собирает;
// • компонент — API отдаёт его контейнер: текст со ссылкой на страницу контейнера и
//   «Операции компонента» — его схемы логики, привязанные к операциям спецификации.
import type { Node, NodeDocMeta } from "../../types";
import type { ContainerSpecGroup } from "../../pages/useContainerChildren";
import type { ContainerLink, PageElement } from "../element/elementView";
import AddDocsMenu from "../AddDocsMenu";
import { DocRowLabel } from "../docRow";
import { DescendantGroups, SpecSplitRow } from "./DescendantGroups";
import type { DocTarget } from "./docTarget";

const MISPLACED_SPECS = "Спецификацию отдаёт контейнер целиком, у компонентов она не на месте";

export default function OpenApiSection({
  spec, docs, element, containerHasSpec, isArchitect, allowed, legacy, groups, loading,
  onOpen, onOpenChildSpec, onTransfer, onCollect, onNavigateNode,
}: {
  // Спека самого объекта (null — нет).
  spec: string | null;
  // Схемы логики объекта: у компонента из них — «Операции компонента».
  docs: NodeDocMeta[];
  // Как страница читает объект (components/element/elementView.pageElement).
  element: PageElement;
  // Есть ли спецификация у контейнера компонента; null — неизвестно (не компонент,
  // контейнер ещё грузится или не найден).
  containerHasSpec: boolean | null;
  isArchitect: boolean;
  // OpenAPI уместен этой форме (types/shapeDocs).
  allowed: boolean;
  // Легаси: у формы спеки быть не должно, а она есть — показываем с предупреждением.
  legacy: boolean;
  // Спеки компонентов по непосредственным детям (у контейнера с компонентами и у
  // составного компонента; у остальных пусто) и признак их загрузки.
  groups: ContainerSpecGroup[];
  loading: boolean;
  onOpen: (target: DocTarget) => void;
  // Спека ребёнка открывается в его CAS-контексте (страница держит базу правки).
  onOpenChildSpec: (child: Node) => void;
  // «Перенести документацию» (Р19) — только у системы: у неё своей спецификации нет;
  // у контейнера спецификация на месте, и кнопки нет (undefined).
  onTransfer?: () => void;
  // «Собрать с компонентов» — у контейнера, у компонентов которого есть спецификация.
  onCollect?: () => void;
  onNavigateNode: (id: string) => void;
}) {
  const kind = element.kind;

  // Компонент: API отдаёт контейнер. Секция видна обеим ролям — она объясняет, где искать.
  if (kind === "component" || kind === "composite") {
    return (
      <div className="np-card">
        <h3 className="np-card-title">OpenAPI</h3>
        <ComponentApi
          container={element.container}
          hasSpec={containerHasSpec}
          onNavigateNode={onNavigateNode}
        />
        {/* Своя спецификация у компонента — старые данные: показываем с подсказкой, куда
            её собрать. Меню «+ Добавить» у компонента нет. */}
        {spec && (
          <>
            <p className="np-warn">
              Спецификацию отдаёт контейнер целиком. Перенесите её в «{element.container.name}»: на его странице есть кнопка «Собрать с компонентов»
            </p>
            <button className="np-doc-row" onClick={() => onOpen({ mode: "openapi" })}>
              <DocRowLabel name="Спецификация" />
            </button>
          </>
        )}
        <ComponentOperations docs={docs} onOpen={onOpen} />
        {/* Составной компонент: спецификации вложенных — с той же пометкой, что у
            контейнера; собирает их страница контейнера. */}
        {kind === "composite" && groups.length > 0 && (
          <SpecGroups groups={groups} onOpenChildSpec={onOpenChildSpec} onNavigateNode={onNavigateNode} />
        )}
      </div>
    );
  }

  // Система: своего API нет; групп потомков нет (Р34), меню «+ Добавить» тоже.
  if (kind === "system") {
    if (!(isArchitect || spec)) return null;
    return (
      <div className="np-card">
        <h3 className="np-card-title">OpenAPI</h3>
        {spec ? (
          <>
            <p className="np-warn">
              У системы осталась собственная спецификация. API отдают контейнеры, перенесите её одному из них
            </p>
            <button className="np-doc-row" onClick={() => onOpen({ mode: "openapi" })}>
              <DocRowLabel name="Спецификация" />
            </button>
            {isArchitect && onTransfer && (
              <button type="button" className="np-addbtn" onClick={onTransfer}>
                Перенести документацию
              </button>
            )}
          </>
        ) : (
          <p className="np-empty">Это система, своего API у неё нет. Спецификации описывают у её контейнеров</p>
        )}
      </div>
    );
  }

  // Контейнер (с компонентами и без) и прочие объекты без вложенных.
  if (!(allowed || legacy || groups.length > 0)) return null;
  if (!(isArchitect || spec || groups.length > 0)) return null;

  // Меню «+ Добавить» (когда спеки нет): окно спеки сразу в нужном режиме — «Вручную»
  // (редактор) или «Через ИИ-агента» (панель агента). Когда спека есть, её обновляют в
  // самом окне («Изменить»).
  const addMenu = allowed && isArchitect ? (
    <AddDocsMenu
      groups={[
        [{ label: "Вручную", onSelect: () => onOpen({ mode: "openapi", stage: "manual" }) }],
        [{ label: "Через ИИ-агента", onSelect: () => onOpen({ mode: "openapi", stage: "agent" }) }],
      ]}
    />
  ) : null;

  return (
    <div className="np-card">
      <h3 className="np-card-title">OpenAPI</h3>
      {spec ? (
        <>
          {legacy && (
            <p className="np-warn">
              OpenAPI описывает HTTP-API, который объект предоставляет сам, — у этого объекта его нет
            </p>
          )}
          <button className="np-doc-row" onClick={() => onOpen({ mode: "openapi" })}>
            <DocRowLabel name="Спецификация" />
          </button>
        </>
      ) : (
        <>
          <p className="np-empty">Спецификация не задана</p>
          {addMenu}
        </>
      )}
      {/* Контейнер с компонентами: спецификации компонентов (дети и глубже) группами по
          непосредственным детям — у компонентов она не на месте, контейнер собирает её
          к себе (Р19). */}
      {kind === "container" && (
        <>
          {groups.length > 0 && (
            <SpecGroups groups={groups} onOpenChildSpec={onOpenChildSpec} onNavigateNode={onNavigateNode} />
          )}
          {isArchitect && onCollect && (
            <button type="button" className="np-addbtn" onClick={onCollect}>
              Собрать с компонентов
            </button>
          )}
          {loading && <p className="np-empty">Загрузка…</p>}
        </>
      )}
    </div>
  );
}

// Где API компонента: у его контейнера. Есть спецификация — кнопка ведёт на страницу
// контейнера; нет — так и сказано; неизвестно (контейнер не загружен) — без продолжения.
function ComponentApi({ container, hasSpec, onNavigateNode }: {
  container: ContainerLink;
  hasSpec: boolean | null;
  onNavigateNode: (id: string) => void;
}) {
  const lead = `API этого компонента отдаёт контейнер «${container.name}»`;
  const tail = hasSpec === true ? ", спецификация описана у него" : hasSpec === false ? ", спецификация пока не описана" : "";
  const id = container.id;
  return (
    <>
      <p className="np-inherit">{lead}{tail}</p>
      {hasSpec === true && id !== null && (
        <button type="button" className="np-addbtn" onClick={() => onNavigateNode(id)}>
          Открыть спецификацию
        </button>
      )}
    </>
  );
}

// «Операции компонента»: его схемы логики с привязкой к операции спецификации.
function ComponentOperations({ docs, onOpen }: {
  docs: NodeDocMeta[];
  onOpen: (target: DocTarget) => void;
}) {
  const ops = docs.filter((d) => d.operation);
  return (
    <>
      <div className="np-sublabel">Операции компонента</div>
      {ops.length === 0 ? (
        <p className="np-empty">Схемы логики этого компонента не привязаны к операциям спецификации</p>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
          {ops.map((d) => (
            <button key={d.id} className="np-doc-row" onClick={() => onOpen({ mode: "flowchart", docId: d.id })}>
              <DocRowLabel name={d.name} kind={d.kind} stub={!d.described} operation={d.operation} />
            </button>
          ))}
        </div>
      )}
    </>
  );
}

// Спецификации компонентов группами по непосредственным детям: спека ребёнка — плоская
// split-кнопка, спеки глубоких потомков — в раскрываемой группе под ним.
function SpecGroups({ groups, onOpenChildSpec, onNavigateNode }: {
  groups: ContainerSpecGroup[];
  onOpenChildSpec: (child: Node) => void;
  onNavigateNode: (id: string) => void;
}) {
  return (
    <>
      <div className="np-sublabel">Спецификации компонентов</div>
      <p className="np-warn">{MISPLACED_SPECS}</p>
      <DescendantGroups
        groups={groups}
        words={["спецификация", "спецификации", "спецификаций"]}
        own={(group) => group.own && (
          <SpecSplitRow child={group.child} onOpen={onOpenChildSpec} onNavigateNode={onNavigateNode} />
        )}
        deep={(group) => group.deep}
        renderDeep={(child) => (
          <SpecSplitRow key={child.id} child={child} onOpen={onOpenChildSpec} onNavigateNode={onNavigateNode} />
        )}
      />
    </>
  );
}
