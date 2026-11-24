// Строка «Размещение» свойств страницы объекта (docs/tasks/deployment-view.md, Ф3): где
// крутится объект — имена площадок из node.sites через запятую. Родитель площадки и
// пометка «часть контейнеров» — подсказкой на имени, а не текстом строки. Редактор
// открывает значение целиком тем же окном «Размещение», что и на холсте развёртывания, —
// для одного объекта; площадки грузятся по нажатию, окно само их не грузит.
//
// По элементу архитектуры (Ф8 эпика docs/plan-c4-elements.md): площадки хранятся у
// контейнера. У системы это площадки её контейнеров; где стоит часть, говорит подсказка.
// Компонент размещается вместе с контейнером: строка показывает площадки контейнера, без
// правки. У внешней системы (Р42) размещение не ведётся — строка так и говорит. Читателю
// строка без площадок не рисуется: пустое значение нужно только тому, кто его задаёт.
// Строка — пара dt/dd сетки свойств, окно — внутри значения: открытый <dialog> живёт в
// верхнем слое и места в строке не занимает.
import { Fragment, useState } from "react";
import type { ReactNode } from "react";
import type { Node, SiteOut } from "../../types";
import { deploymentApi } from "../../api/deployment";
import { loadErrorText } from "../../ui/loadErrorText";
import PlacementDialog from "../deployment/PlacementDialog";
import { placementFromNode } from "../deployment/placementFromNode";
import type { PageElement } from "../element/elementView";
import { Prop } from "./PropRows";
import "../../ui/ds.css";

interface Props {
  node: Node;
  // Как страница читает объект (components/element/elementView.pageElement).
  element: PageElement;
  // Площадки контейнера компонента; null — не компонент или контейнер ещё грузится.
  containerSites: Node["sites"] | null;
  isArchitect: boolean;
  // Из окна записано размещение или заведена площадка — страница перечитывает узел.
  onChanged: () => void;
}

type Site = Node["sites"][number];

const PARTIAL_HINT = "Здесь размещена часть контейнеров системы";

// Подсказка на имени площадки: где она лежит и размещена ли здесь вся система.
function siteHint(s: Site): string | undefined {
  const parts = [s.parent_name ? `В площадке «${s.parent_name}»` : "", s.partial ? PARTIAL_HINT : ""].filter(Boolean);
  return parts.length > 0 ? parts.join(". ") : undefined;
}

// Имена площадок через запятую; пусто — «не указано».
function SiteNames({ sites }: { sites: Site[] }) {
  if (sites.length === 0) return <span className="ds-empty">не указано</span>;
  return (
    <span className="np-sites">
      {sites.map((s, i) => (
        <Fragment key={s.id}>
          {i > 0 && ", "}
          <span className="np-site" title={siteHint(s)}>{s.name}</span>
        </Fragment>
      ))}
    </span>
  );
}

// Строка — общая пара «подпись — значение» строк свойств (PropRows).
function Row({ title, children }: { title?: string; children: ReactNode }) {
  return <Prop term="Размещение" title={title}>{children}</Prop>;
}

export default function PlacementRow({ node, element, containerSites, isArchitect, onChanged }: Props) {
  // Площадки проекта для окна: есть список — окно открыто.
  const [sites, setSites] = useState<SiteOut[] | null>(null);
  const [loading, setLoading] = useState(false);
  // Отказ загрузки площадок — текстом под значением, а не молчанием.
  const [error, setError] = useState<string | null>(null);

  // Пока площадки читаются, кнопка не запирается: запертая теряла бы фокус ещё до открытия
  // окна, и окно не знало бы, куда вернуть фокус после закрытия (ui/Modal). Повторное
  // нажатие во время чтения гасится здесь.
  const openDialog = () => {
    if (loading) return;
    setLoading(true);
    setError(null);
    deploymentApi.sites()
      .then(setSites)
      .catch((e: unknown) => setError(`Не удалось загрузить площадки. ${loadErrorText(e)}`))
      .finally(() => setLoading(false));
  };

  // Компонент: площадки его контейнера, правки здесь нет (D29: площадки задаются
  // контейнеру). Пока контейнер грузится — пусто.
  if (element.kind === "component" || element.kind === "composite") {
    if (!isArchitect && (containerSites === null || containerSites.length === 0)) return null;
    return (
      <Row title={`Как у контейнера «${element.container.name}»: компонент размещается вместе с ним`}>
        {containerSites !== null && <SiteNames sites={containerSites} />}
      </Row>
    );
  }

  // Внешняя система — чёрный ящик чужого продукта: площадок проекта у неё нет и не будет.
  if (element.kind === "external") {
    if (!isArchitect) return null;
    return (
      <Row>
        <span className="ds-empty">не ведётся у внешней системы</span>
      </Row>
    );
  }

  if (!isArchitect && node.sites.length === 0) return null;
  return (
    <Row>
      {isArchitect ? (
        <button
          type="button"
          className="ds-value-btn"
          onClick={openDialog}
          aria-busy={loading}
          aria-label="Изменить размещение"
        >
          <SiteNames sites={node.sites} />
        </button>
      ) : (
        <SiteNames sites={node.sites} />
      )}
      {error && <span className="np-site-err" role="alert">{error}</span>}
      {sites && (
        <PlacementDialog
          objects={[placementFromNode(node)]}
          sites={sites}
          onClose={() => setSites(null)}
          onApplied={() => { setSites(null); onChanged(); }}
          onSitesChanged={onChanged}
        />
      )}
    </Row>
  );
}
