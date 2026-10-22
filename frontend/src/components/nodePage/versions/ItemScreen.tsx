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
import BackButton from "./BackButton";
import type { SideLabels } from "./VersionScreen";
import "./versions.css";

type ViewKey = "changes" | "before" | "after";

export default function ItemScreen({ nodeId, num, base, item, labels, onBack }: {
  nodeId: string | null;
  num: number;
  base: VersionBase;
  item: VersionItem;
  labels: SideLabels;
  onBack: () => void;
}) {
  // Три представления приходят одним ответом — переключение сегментов без сети.
  const detail = useVersionItem(nodeId, num, item.item_id, base);
  const [view, setView] = useState<ViewKey>("changes");
  const segments: [ViewKey, string][] = [["changes", "Изменения"], ["before", labels.before], ["after", labels.after]];
  return (
    <>
      <div className="vp-head">
        <BackButton onClick={onBack} />
        <span className="vp-title">{itemTitle(item)}</span>
        <span className="vp-spacer" />
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
      </div>
      <div className="vp-body">
        {detail.error ? (
          <LoadError what="изменения" error={detail.error} onRetry={detail.reload} />
        ) : (
          <div className="vp-item">
            {detail.data === null
              ? <p className="vp-empty">Загрузка…</p>
              : <VersionViewBlock view={detail.data[view]} />}
          </div>
        )}
      </div>
    </>
  );
}
