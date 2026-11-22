// Окно «Размещение» (docs/tasks/deployment-view.md §6): где крутятся выбранные объекты.
// Площадки деревом с галочками — НАБОР площадок каждого объекта целиком. Галочка
// стоит, если на площадке стоят все выбранные; частичная — часть (у системы — часть её
// единиц). Частичную галочку, которую не трогали, применение сохраняет как есть у
// каждого объекта. Дерево площадок — общее с окном «Площадки» (SiteTree): свёрнуто,
// кроме предков площадок, где стоят выбранные; новая площадка заводится «+» в дереве
// (родитель — где нажали) и сразу отмечена. Размещение хранится у единиц — контейнеров
// (deployment.md D30, D33): контейнер, в том числе с компонентами, пишется сам; система
// — это её единицы, им и пишется набор (состав проекта грузится при открытии);
// «Снять размещение» у системы снимает его у всех её единиц — второй шаг в том же окне
// со списком «объект: площадки» (вложенный <dialog> нельзя), «Снять» / «Отмена»
// («Отмена» возвращает к галочкам).
// Вид (редизайн, фаза 11): каркас окна нового языка (ui/ds.css, ds-win) шириной 520,
// прижатый к верху экрана (ds-win--top): дерево раскрывается и высота окна меняется, а верх
// стоит на месте. Окно не выше экрана, прокручивается тело. Первым абзацем тела — о ком
// речь, у одной системы вторым — кому достанутся площадки.
import { useState } from "react";
import type { ReactNode } from "react";
import type { DeploymentNode, Node, SiteOut } from "../../types";
import Modal from "../../ui/Modal";
import { CloseIcon } from "../../ui/icons";
import { plural } from "../../ui/plural";
import { loadErrorText } from "../../ui/loadErrorText";
import { deploymentApi } from "../../api/deployment";
import { nodesApi } from "../../api/nodes";
import { useAsyncLoad } from "../../lib/useAsyncLoad";
import { limitMessage } from "../demo/demoLimits";
import { LimitText } from "../demo/DemoLimitToast";
import type { SiteFormValue } from "./SiteForm";
import SiteTree, { SiteRowTitle } from "./SiteTree";
import { useSiteExpansion } from "./useSiteExpansion";
import { siteAncestorIds } from "./siteTree";
import PlacementConflictList from "./PlacementConflictList";
import { unitsOf, UNPLACE_LEAD, unplaceQuestion, type PlacementConflict } from "./placementConflicts";
import "../../ui/ds.css";
import "./deployment.css";

type Mark = "on" | "off" | "mixed";

interface Props {
  // выбранные объекты (один или несколько)
  objects: DeploymentNode[];
  sites: SiteOut[];
  onClose: () => void;
  // размещение записано — хозяин перечитывает граф
  onApplied: () => void;
  // заведена площадка — хозяин перечитает граф (она появится на холсте карточкой)
  onSitesChanged: () => void;
}

// Кому пишется набор: единица — она сама, система — её единицы.
type Target = Pick<Node, "id" | "name" | "parent_id" | "sites" | "element_effective">;
// Запрос записи: объектам — ровно этот набор.
interface WriteGroup { nodeIds: string[]; siteIds: string[] }

const NO_NODES: Node[] = [];

// Окно у верха экрана (как окно версий): верх на месте, когда дерево раскрывается.
const BOX = { width: 520, padding: 0, margin: "8vh auto auto" };

// Состояние галочки площадки: стоят все выбранные (у системы — все её единицы:
// instances), никто (площадки нет и в sites), иначе — часть.
function initialMarks(objects: DeploymentNode[], sites: SiteOut[]): Record<string, Mark> {
  const out: Record<string, Mark> = {};
  for (const s of sites) {
    const all = objects.every((o) => o.instances.includes(s.id));
    const any = objects.some((o) => o.sites.some((x) => x.id === s.id));
    out[s.id] = all ? "on" : any ? "mixed" : "off";
  }
  return out;
}

// Площадки, где стоят выбранные (у системы — хоть одна единица внутри), видны сразу:
// их предки раскрыты, остальное дерево свёрнуто.
function initialExpanded(objects: DeploymentNode[], sites: SiteOut[]): Set<string> {
  const out = new Set<string>();
  for (const o of objects) {
    for (const s of o.sites) for (const id of siteAncestorIds(sites, s.id)) out.add(id);
  }
  return out;
}

// Единицы, которым пишется набор: единица (контейнер, в том числе с компонентами) —
// сама, система — её единицы по составу проекта. Система без единиц едет сама — сервер
// ответит, что размещать в ней нечего.
function targetsOf(objects: DeploymentNode[], all: Node[]): Target[] {
  const out = new Map<string, Target>();
  for (const o of objects) {
    const units = o.element_effective === "system" ? unitsOf<Target>(all, o) : [];
    for (const t of units.length > 0 ? units : [o]) out.set(t.id, t);
  }
  return [...out.values()];
}

export default function PlacementDialog({ objects, sites: initialSites, onClose, onApplied, onSitesChanged }: Props) {
  const [sites, setSites] = useState<SiteOut[]>(initialSites);
  const [marks, setMarks] = useState<Record<string, Mark>>(() => initialMarks(objects, initialSites));
  const { expanded, toggle } = useSiteExpansion(() => initialExpanded(objects, initialSites));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ReactNode>(null);
  // Среди объектов есть система — набор пишется её единицам, нужен состав проекта
  // (один запрос при открытии; галочки им не блокируются, ждут только записи).
  const systemCount = objects.filter((o) => o.element_effective === "system").length;
  const needAll = systemCount > 0;
  const all = useAsyncLoad(needAll ? "placement-nodes" : "placement-none", () => (needAll ? nodesApi.getAll() : Promise.resolve(NO_NODES)));
  // Второй шаг: подтверждение снятия размещения у единиц системы.
  const [clearing, setClearing] = useState<PlacementConflict[] | null>(null);

  const toggleMark = (siteId: string) => {
    setMarks((m) => ({ ...m, [siteId]: m[siteId] === "on" ? "off" : "on" }));
  };

  const hasOwn = objects.some((o) => o.sites.length > 0);
  // О ком речь: имя объекта либо «3 объекта». Окно на одной системе вторым абзацем
  // говорит, кому достанутся площадки: её контейнерам (единицам). На нескольких объектах
  // второго абзаца нет: среди них бывают и контейнеры.
  const single = objects.length === 1 ? objects[0] : null;
  const singleSystem = single !== null && single.element_effective === "system";
  const who = single
    ? single.name
    : `${objects.length} ${plural(objects.length, ["объект", "объекта", "объектов"])}`;

  const run = async (write: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    try {
      await write();
      onApplied();
    } catch (e) {
      setError(loadErrorText(e));
    } finally {
      setBusy(false);
    }
  };

  const targets = () => targetsOf(objects, all.data ?? NO_NODES);

  // План записи: отмеченные площадки — всем; нетронутые частичные — как было у каждого.
  // Без частичных — один запрос на всех; с ними — по запросу на каждый итоговый набор.
  const plan = (): WriteGroup[] => {
    const on = sites.filter((s) => marks[s.id] === "on").map((s) => s.id);
    const mixed = sites.filter((s) => marks[s.id] === "mixed").map((s) => s.id);
    const groups = new Map<string, WriteGroup>();
    for (const t of targets()) {
      const siteIds = [...on, ...mixed.filter((id) => t.sites.some((s) => s.id === id))];
      const key = [...siteIds].sort().join(",");
      const g = groups.get(key) ?? { siteIds, nodeIds: [] };
      g.nodeIds.push(t.id);
      groups.set(key, g);
    }
    return [...groups.values()];
  };
  const apply = () => run(async () => {
    for (const g of plan()) await deploymentApi.setPlacements(g.nodeIds, g.siteIds);
  });

  // Снять размещение: у единиц — сразу; есть система — сначала список, у кого внутри
  // оно снимется.
  const clearAll = () => run(() => deploymentApi.setPlacements(targets().map((t) => t.id), []));
  const removeAll = () => {
    if (!needAll) {
      void clearAll();
      return;
    }
    const items = targets()
      .filter((t) => t.sites.length > 0)
      .map((t) => ({ node: t, siteNames: t.sites.map((s) => s.name) }))
      .sort((a, b) => a.node.name.localeCompare(b.node.name, "ru"));
    setError(null);
    setClearing(items);
  };

  const createSite = async (parentId: string | null, v: SiteFormValue): Promise<boolean> => {
    setBusy(true);
    setError(null);
    try {
      const created = await deploymentApi.createSite({
        name: v.name.trim(),
        kind: v.kind,
        technology: v.technology.trim() || null,
        description: v.description.trim() || null,
        parent_id: parentId,
      });
      setSites((s) => [...s, created]);
      setMarks((m) => ({ ...m, [created.id]: "on" }));
      onSitesChanged();
      return true;
    } catch (e) {
      const limit = limitMessage(e, "site");
      setError(limit ? <LimitText message={limit} /> : loadErrorText(e));
      return false;
    } finally {
      setBusy(false);
    }
  };

  // Второй шаг — вместо галочек в том же окне (вложенный <dialog> нельзя): у кого внутри
  // снимется размещение. Вид подтверждения нового языка (ds-confirm, ui/ConfirmDialog):
  // заголовок-вопрос, пояснение, перечень, «Снять» и «Отмена» (к галочкам). Сам
  // ConfirmDialog сюда не годится: вид card рисует отдельную карточку с рамкой и тенью
  // поверх окна, а отказ у него без role="alert".
  if (clearing) {
    const one = objects.length === 1 ? objects[0] : null;
    return (
      <Modal onClose={onClose} closeButton={false} boxStyle={BOX}>
        <div className="ds ds-win ds-win--top ds-confirm">
          <div className="ds-win-head">
            <h2 className="ds-win-title">{one ? unplaceQuestion(one.name) : "Снять размещение выбранных объектов?"}</h2>
          </div>
          <div className="ds-win-body">
            <p className="ds-confirm-lead">{one ? UNPLACE_LEAD : UNPLACE_LEAD_MANY}</p>
            <PlacementConflictList items={clearing} />
          </div>
          <div className="ds-win-foot">
            {error && <p className="ds-danger ds-win-err" role="alert">{error}</p>}
            <button type="button" className="ds-btn ds-btn--primary" onClick={() => { void clearAll(); }} disabled={busy}>
              Снять
            </button>
            <button type="button" className="ds-btn" onClick={() => { setClearing(null); setError(null); }} disabled={busy}>
              Отмена
            </button>
          </div>
        </div>
      </Modal>
    );
  }

  // Состав проекта ещё грузится (или не загрузился) — ждёт только запись.
  const allPending = needAll && all.data === null;

  return (
    <Modal onClose={onClose} closeButton={false} boxStyle={BOX}>
      <div className="ds ds-win ds-win--top">
        <div className="ds-win-head">
          <h2 className="ds-win-title">Размещение</h2>
          <button type="button" className="ds-icon-btn ds-win-close" aria-label="Закрыть" onClick={onClose}>
            <CloseIcon />
          </button>
        </div>
        <div className="ds-win-body">
          <div className="pl-who">
            <p className="pl-who-name">{who}</p>
            {singleSystem && <p className="pl-who-note">Площадки получат все контейнеры системы</p>}
          </div>
          <SiteTree
            sites={sites}
            expanded={expanded}
            onToggle={toggle}
            disabled={busy}
            create={{ busy, onOpen: () => setError(null), onSubmit: createSite }}
            row={(site) => {
              const mark = marks[site.id] ?? "off";
              return (
                // Вся строка — подпись галочки (галочка нового языка, как в «Доступе к проекту»).
                <label className="site-row-label">
                  <input
                    type="checkbox"
                    checked={mark === "on"}
                    ref={(el) => { if (el) el.indeterminate = mark === "mixed"; }}
                    onChange={() => toggleMark(site.id)}
                    disabled={busy}
                  />
                  <SiteRowTitle site={site} />
                </label>
              );
            }}
          />
        </div>
        <div className="ds-win-foot">
          {error && <p className="ds-danger ds-win-err" role="alert">{error}</p>}
          {needAll && all.error !== null && (
            <p className="ds-danger ds-win-err" role="alert">
              {/* Состав грузится только ради систем — отказ называет их контейнеры. */}
              {systemCount === 1 ? "Не удалось загрузить контейнеры системы." : "Не удалось загрузить контейнеры систем."}{" "}
              {loadErrorText(all.error)}{" "}
              <button type="button" className="pl-retry" onClick={all.reload}>Повторить</button>
            </p>
          )}
          <button type="button" className="ds-btn ds-btn--primary" onClick={() => { void apply(); }} disabled={busy || allPending}>
            Применить
          </button>
          <button type="button" className="ds-btn" onClick={removeAll} disabled={busy || allPending || !hasOwn}>
            Снять размещение
          </button>
          <button type="button" className="ds-btn" onClick={onClose} disabled={busy}>
            Отмена
          </button>
          {needAll && all.loading && <span className="pl-loading">Загрузка</span>}
        </div>
      </div>
    </Modal>
  );
}

// Пояснение второго шага, когда выбранных объектов несколько.
const UNPLACE_LEAD_MANY = "Размещение всех объектов внутри будет снято:";
