// Строка «Размещение» карточки «Свойства» (docs/tasks/deployment-view.md, Ф3): где
// крутится объект — площадки из node.sites (иконка вида площадки, имя, «в <родитель>»
// у вложенной). Редактор правит тем же окном «Размещение», что и на холсте развёртывания, —
// для одного объекта; площадки грузятся по нажатию «Изменить», окно само их не грузит.
//
// По элементу архитектуры (Ф8 эпика docs/plan-c4-elements.md): площадки хранятся у
// контейнера. У системы это площадки её контейнеров, где стоит часть — пометка «часть
// контейнеров». Компонент размещается вместе с контейнером: строка показывает площадки
// контейнера и серым «как у контейнера «X»» (имя — ссылка на его страницу), без
// «Изменить».
// Строка — пара ячеек сетки свойств (терм и значение), окно — рядом с ними: открытый
// <dialog> живёт в верхнем слое и ячейку сетки не занимает.
import { Fragment, useState } from "react";
import type { Node, SiteOut } from "../../types";
import { deploymentApi } from "../../api/deployment";
import { SiteKindIcon } from "../../ui/icons";
import { loadErrorText } from "../../ui/loadErrorText";
import PlacementDialog from "../deployment/PlacementDialog";
import { placementFromNode } from "../deployment/placementFromNode";
import type { PageElement } from "../element/elementView";
import "../element/element.css";

interface Props {
  node: Node;
  // Как страница читает объект (components/element/elementView.pageElement).
  element: PageElement;
  // Площадки контейнера компонента; null — не компонент или контейнер ещё грузится.
  containerSites: Node["sites"] | null;
  isArchitect: boolean;
  // Из окна записано размещение или заведена площадка — страница перечитывает узел.
  onChanged: () => void;
  // Переход на страницу контейнера (у компонента).
  onNavigateNode: (id: string) => void;
}

type Site = Node["sites"][number];

// Перечень площадок через запятую; пусто — «не указано».
function SiteList({ sites }: { sites: Site[] }) {
  if (sites.length === 0) return <span className="np-value--empty">не указано</span>;
  return (
    <>
      {sites.map((s, i) => (
        <Fragment key={s.id}>
          {i > 0 && ", "}
          <span className="np-site">
            <span className="np-site-ico"><SiteKindIcon kind={s.kind} size={14} /></span>
            {s.name}
            {s.parent_name && <span className="np-site-muted">в {s.parent_name}</span>}
            {s.partial && <span className="np-site-muted">часть контейнеров</span>}
          </span>
        </Fragment>
      ))}
    </>
  );
}

export default function PlacementRow({ node, element, containerSites, isArchitect, onChanged, onNavigateNode }: Props) {
  // Площадки проекта для окна: есть список — окно открыто.
  const [sites, setSites] = useState<SiteOut[] | null>(null);
  const [loading, setLoading] = useState(false);
  // Отказ загрузки площадок — текстом под строкой, а не молчанием.
  const [error, setError] = useState<string | null>(null);

  const openDialog = () => {
    setLoading(true);
    setError(null);
    deploymentApi.sites()
      .then(setSites)
      .catch((e: unknown) => setError(`Не удалось загрузить площадки. ${loadErrorText(e)}`))
      .finally(() => setLoading(false));
  };

  // Компонент: площадки его контейнера, правки здесь нет (D29: площадки задаются
  // контейнеру). Пока контейнер грузится — только пометка.
  if (element.kind === "component" || element.kind === "composite") {
    const { id, name } = element.container;
    return (
      <>
        <span className="np-term">Размещение</span>
        <span className="np-value">
          {containerSites !== null && <SiteList sites={containerSites} />}
          <span className="np-site-muted">
            как у контейнера{" "}
            {id !== null ? (
              <button type="button" className="el-link" onClick={() => onNavigateNode(id)}>«{name}»</button>
            ) : (
              `«${name}»`
            )}
          </span>
          {isArchitect && <span className="np-site-note">Компонент размещается вместе с контейнером</span>}
        </span>
      </>
    );
  }

  return (
    <>
      <span className="np-term">Размещение</span>
      <span className="np-value">
        <SiteList sites={node.sites} />
        {isArchitect && (
          <button
            type="button"
            className="np-site-edit"
            onClick={openDialog}
            disabled={loading}
            aria-label="Изменить размещение"
          >
            Изменить
          </button>
        )}
        {error && <span className="np-site-err" role="alert">{error}</span>}
      </span>

      {sites && (
        <PlacementDialog
          objects={[placementFromNode(node)]}
          sites={sites}
          onClose={() => setSites(null)}
          onApplied={() => { setSites(null); onChanged(); }}
          onSitesChanged={onChanged}
        />
      )}
    </>
  );
}
