// Секция «OpenAPI» страницы объекта (аудит F-5: вынесена из NodePage): спека объекта
// или меню «+ Добавить»; у контейнера — собственная (grandfather) спека с
// предупреждением и объединение спек потомков.
import type { Node } from "../../types";
import type { ContainerSpecGroup } from "../../pages/useContainerChildren";
import AddDocsMenu from "../AddDocsMenu";
import { DocRowLabel } from "../docRow";
import { DescendantGroups, SpecSplitRow } from "./DescendantGroups";
import type { DocTarget } from "./docTarget";

export default function OpenApiSection({
  spec, isContainer, isArchitect, allowed, legacy, groups, loading,
  onOpen, onOpenChildSpec, onDistribute, onNavigateNode,
}: {
  // Спека самого объекта (null — нет).
  spec: string | null;
  isContainer: boolean;
  isArchitect: boolean;
  // OpenAPI уместен этой форме (types/shapeDocs).
  allowed: boolean;
  // Легаси: у формы спеки быть не должно, а она есть — показываем с предупреждением.
  legacy: boolean;
  // Спеки потомков контейнера по непосредственным детям и признак их загрузки.
  groups: ContainerSpecGroup[];
  loading: boolean;
  onOpen: (target: DocTarget) => void;
  // Спека ребёнка открывается в его CAS-контексте (страница держит базу правки).
  onOpenChildSpec: (child: Node) => void;
  onDistribute: () => void;
  onNavigateNode: (id: string) => void;
}) {
  if (!(allowed || legacy || groups.length > 0)) return null;
  if (!(isArchitect || spec || groups.length > 0)) return null;

  // Меню «+ Добавить» (когда спеки нет): окно спеки сразу в нужном режиме — «Вручную»
  // (редактор) или «Через ИИ-агента» (панель агента). Когда спека есть, её обновляют в
  // самом окне («Изменить»). Контейнеру спеку создавать нельзя (правила контейнеров).
  const addMenu = !isContainer && allowed && isArchitect ? (
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
      {isContainer ? (
        <>
          {/* Своя (grandfather) спека контейнера: по правилам спеки живут
              на атомарных детях — предупреждение и перенос одному ребёнку. */}
          {spec && (
            <>
              <p className="np-warn">
                У контейнера осталась собственная OpenAPI-спецификация, распределите её по дочерним сервисам
              </p>
              <button className="np-doc-row" onClick={() => onOpen({ mode: "openapi" })}>
                <DocRowLabel name="Спецификация" />
              </button>
              {isArchitect && (
                <button type="button" className="np-addbtn" onClick={onDistribute}>
                  Распределить по детям
                </button>
              )}
            </>
          )}
          {/* Спеки потомков (дети и глубже), сгруппированные по непосредственным
              детям контейнера: спека самого ребёнка — плоская split-кнопка,
              спеки глубоких потомков — в раскрываемой группе под ребёнком. */}
          {groups.length > 0 && (
            <>
              {spec && <div className="np-sublabel">Спецификации потомков</div>}
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
          )}
          {loading && <p className="np-empty">Загрузка данных детей…</p>}
          {!loading && !spec && groups.length === 0 && (
            <p className="np-empty">
              Это контейнер, то есть абстракция. У него нет своих эндпоинтов, они могут быть
              у дочерних сервисов. Задокументируйте контракты дочерних сервисов, и они будут
              отображаться здесь.
            </p>
          )}
        </>
      ) : spec ? (
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
    </div>
  );
}
