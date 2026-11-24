// Экран «элемент» окна версий (редизайн, фаза 9ж): в шапке имя элемента и тихое
// уточнение за ним, в начале тела вкладки «Изменения», «Было в vN», «Стало в vM» (или
// «Стало сейчас») над одним представлением. Старую версию читают здесь же («Было» и
// «Стало»), без отдельного режима страницы.
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
  // Три представления приходят одним ответом — переключение вкладок без сети.
  const detail = useVersionItem(nodeId, num, item.item_id, base);
  const [view, setView] = useState<ViewKey>("changes");
  const segments: [ViewKey, string][] = [["changes", "Изменения"], ["before", labels.before], ["after", labels.after]];
  const head = itemTitle(item);
  return (
    <>
      <ScreenHead title={head.title} sub={head.sub} onBack={onBack} onClose={onClose} />
      <div className="ds-win-body">
        {/* Вкладки нового языка; механика переключателя прежняя (group и aria-pressed). */}
        <div className="ds-tabs vp-tabs" role="group" aria-label="Что показать">
          {segments.map(([key, label]) => (
            <button
              key={key}
              type="button"
              className={view === key ? "ds-tab is-active" : "ds-tab"}
              aria-pressed={view === key}
              onClick={() => setView(key)}
            >
              {label}
            </button>
          ))}
        </div>
        {detail.error ? (
          <LoadError what="изменения" error={detail.error} onRetry={detail.reload} />
        ) : detail.data === null ? (
          <p className="ds-empty vp-flat">Загрузка</p>
        ) : (
          // Ключ — вкладка: «Скопировано» у текста диаграммы одной стороны не переходит на другую.
          <VersionViewBlock key={view} view={detail.data[view]} />
        )}
      </div>
    </>
  );
}
