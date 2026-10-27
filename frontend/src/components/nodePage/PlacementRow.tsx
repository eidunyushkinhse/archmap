// Строка «Размещение» карточки «Свойства» (docs/tasks/deployment-view.md, Ф3): где
// крутится объект — площадки из node.sites (иконка вида площадки, имя, «в <родитель>»
// у вложенной). У контейнера это площадки его объектов: где стоит часть — пометка
// «часть объектов». Редактор правит тем же окном «Размещение», что и на холсте развёртывания, —
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
  // Из окна записано размещение или заведена площадка — страница перечитывает узел.
  onChanged: () => void;
}

export default function PlacementRow({ node, isArchitect, onChanged }: Props) {
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

  const placed = node.sites;

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
                {s.partial && <span className="np-site-muted">часть объектов</span>}
              </span>
            </Fragment>
          ))
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
