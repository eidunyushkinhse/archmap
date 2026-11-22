// Экран «элемент» панели версий: «категория · имя» и сегменты «Изменения · Было ·
// Стало» над одним представлением. Старую версию читают здесь же («Было»/«Стало»), без
// отдельного режима страницы.
import { useState } from "react";
import LoadError from "../../../ui/LoadError";
import type { VersionBase } from "../../../api/versions";
import type { VersionItem } from "../../../types";
import { useVersionItem } from "./useVersions";
import { itemTitle } from "./versionText";
import VersionViewBlock from "./VersionViewBlock";
import ScreenHead from "./ScreenHead";
import type { SideLabels } from "./VersionScreen";
import "../../../ui/ds.css";
import "./versions.css";

type ViewKey = "changes" | "before" | "after";

export default function ItemScreen({ nodeId, num, base, item, labels, onBack, onClose }: {
  nodeId: string | null;
  num: number;
  base: VersionBase;
  item: VersionItem;
  labels: SideLabels;
  onBack: () => void;
  onClose: () => void;
}) {
  // Три представления приходят одним ответом — переключение сегментов без сети.
  const detail = useVersionItem(nodeId, num, item.item_id, base);
  const [view, setView] = useState<ViewKey>("changes");
  const segments: [ViewKey, string][] = [["changes", "Изменения"], ["before", labels.before], ["after", labels.after]];
  const head = itemTitle(item);
  return (
    <>
      <ScreenHead title={head.title} sub={head.sub} onBack={onBack} onClose={onClose} />
      <div className="vp-body">
        <div className="vp-seg" role="group" aria-label="Что показать">
          {segments.map(([key, label]) => (
            <button
              key={key}
              type="button"
              className={view === key ? "is-active" : undefined}
              aria-pressed={view === key}
              onClick={() => setView(key)}
            >
              {label}
            </button>
          ))}
        </div>
        {detail.error ? (
          <LoadError what="изменения" error={detail.error} onRetry={detail.reload} />
        ) : (
          <div className="vp-item">
            {detail.data === null
              ? <p className="vp-empty">Загрузка</p>
              : <VersionViewBlock view={detail.data[view]} />}
          </div>
        )}
      </div>
    </>
  );
}
