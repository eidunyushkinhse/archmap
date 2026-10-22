// Экран «версия» панели версий: «vN · комментарий», «Что изменилось» с тихим выбором
// «с vM / с текущим состоянием» и список элементов дельты (категория, путь и имя,
// статус словами). Внизу редактору — «Восстановить эту версию» (тихая кнопка, как в
// прототипе; недоступна, когда версия последняя и изменений нет), владельцу справа —
// «Удалить версию». Само окно отката — у панели (VersionsPanel): экран только
// просит его открыть и показывает, что подготовка идёт или не удалась.
import LoadError from "../../../ui/LoadError";
import type { VersionBase } from "../../../api/versions";
import type { VersionDiff, VersionItem, VersionOut } from "../../../types";
import { VERSION_CATEGORY } from "../../nodeTerms";
import { useVersionDiff } from "./useVersions";
import { pathPrefix, statusText, versionMeta } from "./versionText";
import BackButton from "./BackButton";
import "./versions.css";

// Подписи сегментов «Было · v2» / «Стало · сейчас» — по сторонам, которые вернул сервер.
export interface SideLabels {
  before: string;
  after: string;
}

// Кнопка отката у редактора: disabled — версия последняя и изменений с неё нет (нечего
// восстанавливать); busy — идёт запрос «что сделает откат» перед окном; error — он не
// удался (показывается в панели, «Повторить» просит заново).
export interface RestoreAction {
  disabled: boolean;
  busy: boolean;
  error: unknown;
  onRestore: () => void;
}

export default function VersionScreen({ nodeId, version, prevNum, base, restore, canDelete, onBack, onBase, onItem, onDelete }: {
  nodeId: string | null;
  version: VersionOut;
  prevNum: number | null;
  base: VersionBase;
  // null — кнопки отката нет (читатель).
  restore: RestoreAction | null;
  canDelete: boolean;
  onBack: () => void;
  onBase: (base: VersionBase) => void;
  onItem: (item: VersionItem, labels: SideLabels) => void;
  onDelete: () => void;
}) {
  const diff = useVersionDiff(nodeId, version.number, base);
  return (
    <>
      <div className="vp-head">
        <BackButton onClick={onBack} />
        <span className="vp-title">v{version.number} · {version.comment}</span>
        <span className="vp-spacer" />
        <span className="vp-meta">{versionMeta(version)}</span>
      </div>
      <div className="vp-body">
        <div className="vp-pending">
          <span className="vp-pending-text">Что изменилось</span>
          <select
            className="vp-sel"
            title="С чем сравнивать"
            aria-label="С чем сравнивать"
            value={base}
            onChange={(e) => onBase(e.target.value === "live" ? "live" : "prev")}
          >
            {/* У первой версии предыдущей нет: сравнение идёт с пустым срезом. */}
            <option value="prev">{prevNum === null ? "с начала" : `с v${prevNum}`}</option>
            <option value="live">с текущим состоянием</option>
          </select>
        </div>
        {diff.error ? (
          <LoadError what="изменения версии" error={diff.error} onRetry={diff.reload} />
        ) : diff.data === null ? (
          <p className="vp-empty vp-note">Загрузка…</p>
        ) : diff.data.items.length === 0 ? (
          <p className="vp-empty vp-note">{emptyDiffText(version.number, prevNum, base)}</p>
        ) : (
          diff.data.items.map((item) => (
            <ItemRow
              key={item.item_id}
              item={item}
              onOpen={() => { if (diff.data) onItem(item, sideLabels(diff.data)); }}
            />
          ))
        )}
        {restore?.error != null && (
          <LoadError what="что изменит откат" error={restore.error} onRetry={restore.onRestore} />
        )}
      </div>
      {/* Низ — только когда в нём есть хотя бы одна кнопка. */}
      {(restore || canDelete) && (
        <div className="vp-foot">
          {restore && (
            <button
              type="button"
              className="vp-link"
              disabled={restore.disabled || restore.busy}
              aria-busy={restore.busy}
              title={restore.disabled ? "Изменений с этой версии нет — восстанавливать нечего" : undefined}
              onClick={restore.onRestore}
            >
              {restore.busy ? "Подготовка…" : "Восстановить эту версию"}
            </button>
          )}
          <span className="vp-spacer" />
          {canDelete && (
            <button type="button" className="vp-link-danger" onClick={onDelete}>Удалить версию</button>
          )}
        </div>
      )}
    </>
  );
}

function emptyDiffText(num: number, prevNum: number | null, base: VersionBase): string {
  if (base === "live") return `Изменений с v${num} нет`;
  if (prevNum === null) return "Первая версия: вся документация объекта добавлена";
  return `Изменений относительно v${prevNum} нет`;
}

// base — null у первой версии «с предыдущей» (сравнение с пустым); target.number — null
// у сравнения «с текущим состоянием».
function sideLabels(diff: VersionDiff): SideLabels {
  const before = diff.base?.number;
  const after = diff.target.number;
  return {
    before: before == null ? "Было" : `Было · v${before}`,
    after: after === null ? "Стало · сейчас" : `Стало · v${after}`,
  };
}

function ItemRow({ item, onOpen }: { item: VersionItem; onOpen: () => void }) {
  const terms = VERSION_CATEGORY[item.category];
  const prefix = pathPrefix(item);
  // Цвет — только у слов «новая/удалена»: у конфигурации и статуса страницы любое
  // изменение называется «изменена», и зелёный цвет у него сбивал бы.
  const word = terms.status[item.status];
  const tone = word === terms.status.changed ? ""
    : item.status === "added" ? " vp-irow-st--add" : " vp-irow-st--del";
  return (
    <button type="button" className="vp-irow" onClick={onOpen}>
      <span className="vp-irow-cat">{terms.label}</span>
      <span className="vp-irow-nm">
        {prefix && <span className="vp-irow-path">{prefix} / </span>}
        {item.name}
      </span>
      <span className={"vp-irow-st" + tone}>{statusText(item)}</span>
      <span className="vp-irow-ch" aria-hidden="true">›</span>
    </button>
  );
}
