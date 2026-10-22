// Строка «Размещение» карточки «Свойства» (docs/tasks/deployment-view.md, Ф3): где
// крутится объект — действующие экземпляры из node.sites (иконка вида площадки, имя,
// «в <родитель>» у вложенной). Унаследованное от контейнера помечено «от контейнера
// «X»». Редактор правит тем же окном «Размещение», что и на холсте развёртывания, —
// для одного объекта; площадки грузятся по нажатию «Изменить», окно само их не грузит.
// Строка — пара ячеек сетки свойств (терм и значение), окно — рядом с ними: открытый
// <dialog> живёт в верхнем слое и ячейку сетки не занимает.
import { Fragment, useState } from "react";
import type { Node, SiteOut } from "../../types";
import { deploymentApi } from "../../api/deployment";
import { SiteKindIcon } from "../../ui/icons";
import { loadErrorText } from "../../ui/loadErrorText";
import PlacementDialog from "../deployment/PlacementDialog";
import { placementFromNode } from "../deployment/placementFromNode";

interface Props {
  node: Node;
  isArchitect: boolean;
  // Контейнер: его своё размещение наследуют объекты внутри — это поясняется строкой.
  isContainer: boolean;
  // Из окна записано размещение или заведена площадка — страница перечитывает узел.
  onChanged: () => void;
}

export default function PlacementRow({ node, isArchitect, isContainer, onChanged }: Props) {
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

  // Своё и действующее совпадают по построению: со своими экземплярами действуют они,
  // без своих все строки унаследованы от одного предка.
  const placed = node.sites;
  const inherited = placed.find((s) => s.inherited_from_id);
  const ownPlaced = placed.length > 0 && !inherited;

  return (
    <>
      <span className="np-term">Размещение</span>
      <span className="np-value">
        {placed.length === 0 ? (
          <span className="np-value--empty">не указано</span>
        ) : (
          placed.map((s, i) => (
            <Fragment key={s.id}>
              {i > 0 && ", "}
              <span className="np-site">
                <span className="np-site-ico"><SiteKindIcon kind={s.kind} size={14} /></span>
                {s.name}
                {s.parent_name && <span className="np-site-muted">в {s.parent_name}</span>}
              </span>
            </Fragment>
          ))
        )}
        {inherited && (
          <span className="np-site-muted np-site-from">
            {inherited.inherited_from_name ? `от контейнера «${inherited.inherited_from_name}»` : "от контейнера"}
          </span>
        )}
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
        {isContainer && ownPlaced && (
          <span className="np-site-hint">наследуют объекты внутри без своего размещения</span>
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
