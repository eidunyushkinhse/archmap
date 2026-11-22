// Экран «версия» окна версий (редизайн, фаза 9ж): шапка «Версия N», комментарий версии и
// под ним тихо «автор, дата», блок «Что изменилось» со списком выбора «с vM / с текущим
// состоянием» в строке заголовка и строки элементов дельты (категория, путь и имя, слово
// статуса, шеврон). В подвале редактору — «Восстановить эту версию» (заперта, когда версия
// последняя и изменений нет), владельцу у правого края — «Удалить версию» тихой красной
// кнопкой-текстом. Само окно отката — у VersionsPanel: экран только просит его открыть и
// показывает, что подготовка идёт или не удалась.
import LoadError from "../../../ui/LoadError";
import type { VersionBase } from "../../../api/versions";
import type { VersionDiff, VersionItem, VersionOut } from "../../../types";
import { VERSION_CATEGORY } from "../../nodeTerms";
import { ChevronDownIcon, ChevronIcon } from "../../../ui/icons";
import { useVersionDiff } from "./useVersions";
import { pathPrefix, statusText, versionByline } from "./versionText";
import ScreenHead from "./ScreenHead";
import "../../../ui/ds.css";
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

export default function VersionScreen({ nodeId, version, prevNum, base, restore, canDelete, onBack, onBase, onItem, onDelete, onClose }: {
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
  onClose: () => void;
}) {
  const diff = useVersionDiff(nodeId, version.number, base);
  return (
    <>
      <ScreenHead title={`Версия ${version.number}`} onBack={onBack} onClose={onClose} />
      <div className="ds-win-body">
        {/* Комментарий версии и под ним тихо «автор, дата». */}
        <div className="vp-about">
          <p className="vp-comment">{version.comment}</p>
          <p className="vp-byline">{versionByline(version)}</p>
        </div>
        <section className="ds-win-block">
          <div className="vp-block-head">
            <h3 className="ds-win-block-title">Что изменилось</h3>
            <span className="ds-select vp-base">
              <select
                title="С чем сравнивать"
                aria-label="С чем сравнивать"
                value={base}
                onChange={(e) => onBase(e.target.value === "live" ? "live" : "prev")}
              >
                {/* У первой версии предыдущей нет: сравнение идёт с пустым срезом. */}
                <option value="prev">{prevNum === null ? "с начала" : `с v${prevNum}`}</option>
                <option value="live">с текущим состоянием</option>
              </select>
              <ChevronDownIcon />
            </span>
          </div>
          {diff.error ? (
            <LoadError what="изменения версии" error={diff.error} onRetry={diff.reload} />
          ) : diff.data === null ? (
            <p className="ds-empty vp-flat">Загрузка</p>
          ) : diff.data.items.length === 0 ? (
            <p className="ds-empty vp-flat">{emptyDiffText(version.number, prevNum, base)}</p>
          ) : (
            <div className="vp-irows">
              {diff.data.items.map((item) => (
                <ItemRow
                  key={item.item_id}
                  item={item}
                  onOpen={() => { if (diff.data) onItem(item, sideLabels(diff.data)); }}
                />
              ))}
            </div>
          )}
        </section>
        {restore?.error != null && (
          <LoadError what="что изменит откат" error={restore.error} onRetry={restore.onRestore} />
        )}
      </div>
      {/* Подвал — только когда в нём есть хотя бы одна кнопка. */}
      {(restore || canDelete) && (
        <div className="ds-win-foot">
          {restore && (
            <button
              type="button"
              className="ds-btn"
              disabled={restore.disabled || restore.busy}
              aria-busy={restore.busy}
              title={restore.disabled ? "Изменений с этой версии нет, восстанавливать нечего" : undefined}
              onClick={restore.onRestore}
            >
              {restore.busy ? "Готовим" : "Восстановить эту версию"}
            </button>
          )}
          {canDelete && (
            <button type="button" className="ds-text-danger vp-delete" onClick={onDelete}>Удалить версию</button>
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

// Строка элемента дельты — одна кнопка: категория тихим цветом (колонка одной ширины во
// всех строках — общая сетка списка, versions.css), путь объекта тихо перед именем, слово
// статуса у правого края и шеврон.
function ItemRow({ item, onOpen }: { item: VersionItem; onOpen: () => void }) {
  const terms = VERSION_CATEGORY[item.category];
  const prefix = pathPrefix(item);
  // Цвет — только у слов «новая/удалена»: у конфигурации и статуса страницы любое
  // изменение называется «изменена», и зелёный цвет у него сбивал бы.
  const word = statusText(item);
  const tone = word === terms.status.changed ? ""
    : item.status === "added" ? " vp-irow-st--add" : " vp-irow-st--del";
  return (
    <button type="button" className="vp-irow" onClick={onOpen}>
      <span className="vp-irow-cat">{terms.label}</span>
      <span className="vp-irow-nm" title={prefix ? `${prefix} / ${item.name}` : item.name}>
        {prefix && <span className="vp-irow-path">{prefix} / </span>}
        {item.name}
      </span>
      <span className={"vp-irow-st" + tone}>{word}</span>
      <span className="vp-irow-ch"><ChevronIcon size={12} /></span>
    </button>
  );
}
