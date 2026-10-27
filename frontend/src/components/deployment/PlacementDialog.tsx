// Окно «Размещение» (docs/tasks/deployment-view.md §6): где крутятся выбранные объекты.
// Площадки деревом с галочками — НАБОР экземпляров каждого объекта целиком. Галочка
// стоит, если СВОЙ экземпляр на площадке есть у всех выбранных; частичная — у части;
// у площадки, где размещение только унаследовано, — подпись «унаследовано от «X»».
// Частичную галочку, которую не трогали, применение сохраняет как есть у каждого
// объекта. Дерево площадок — общее с окном «Площадки» (SiteTree): свёрнуто, кроме
// предков площадок, где стоят выбранные; новая площадка заводится «+» в дереве
// (родитель — где нажали) и сразу отмечена. Контейнер размещается
// ЦЕЛИКОМ (deployment.md D30): своё размещение объектов внутри снимается; если у кого-то
// оно на других площадках — второй шаг в том же окне со списком «объект: площадки»
// (вложенный <dialog> нельзя), «Разместить» / «Назад».
import { useState } from "react";
import type { ReactNode } from "react";
import type { DeploymentNode, Node, SiteOut } from "../../types";
import Modal from "../../ui/Modal";
import DialogTitle from "../../ui/DialogTitle";
import { errText, primaryBtn, secondaryBtn } from "../../ui/styles";
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
import { PLACE_LEAD, placementConflicts, placeQuestion, type PlacementConflict } from "./placementConflicts";
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

// Запрос записи: объектам — ровно этот набор; clear — в группе контейнер с непустым
// набором, он размещается целиком (флаг у листа безвреден: потомков у него нет).
interface WriteGroup { nodeIds: string[]; siteIds: string[]; clear: boolean }
// Контейнер, чьё размещение снимет своё размещение объектов внутри на других площадках.
interface ContainerConflicts { container: DeploymentNode; siteIds: string[]; conflicts: PlacementConflict[] }

const NO_NODES: Node[] = [];

// Состояние галочки площадки по своим экземплярам выбранных объектов.
function initialMarks(objects: DeploymentNode[], sites: SiteOut[]): Record<string, Mark> {
  const out: Record<string, Mark> = {};
  for (const s of sites) {
    const own = objects.filter((o) => o.instances.includes(s.id)).length;
    out[s.id] = own === 0 ? "off" : own === objects.length ? "on" : "mixed";
  }
  return out;
}

// Площадки, где стоят выбранные (своё или унаследованное размещение), видны сразу:
// их предки раскрыты, остальное дерево свёрнуто.
function initialExpanded(objects: DeploymentNode[], sites: SiteOut[]): Set<string> {
  const out = new Set<string>();
  for (const o of objects) {
    for (const e of o.effective) for (const id of siteAncestorIds(sites, e.site_id)) out.add(id);
  }
  return out;
}

export default function PlacementDialog({ objects, sites: initialSites, onClose, onApplied, onSitesChanged }: Props) {
  const [sites, setSites] = useState<SiteOut[]>(initialSites);
  const [marks, setMarks] = useState<Record<string, Mark>>(() => initialMarks(objects, initialSites));
  const { expanded, toggle } = useSiteExpansion(() => initialExpanded(objects, initialSites));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ReactNode>(null);
  // Среди объектов есть контейнер — для предупреждения нужен состав проекта (один запрос
  // при открытии; галочки им не блокируются, ждёт только «Применить»).
  const needAll = objects.some((o) => o.has_children);
  const all = useAsyncLoad(needAll ? "placement-nodes" : "placement-none", () => (needAll ? nodesApi.getAll() : Promise.resolve(NO_NODES)));
  // Второй шаг: подтверждение размещения контейнеров целиком (галочки сохраняются).
  const [step, setStep] = useState<{ groups: WriteGroup[]; items: ContainerConflicts[] } | null>(null);
  const siteName = (id: string) => sites.find((s) => s.id === id)?.name ?? id;

  // «унаследовано от «X»» — у площадки, где своего экземпляра нет ни у кого из
  // выбранных, а действующий (от предка) есть.
  const inheritedFrom = (siteId: string): string | null => {
    if (marks[siteId] !== "off") return null;
    for (const o of objects) {
      const ref = o.sites.find((s) => s.id === siteId && s.inherited_from_id);
      if (ref) return ref.inherited_from_name ?? null;
    }
    return null;
  };

  const toggleMark = (siteId: string) => {
    setMarks((m) => ({ ...m, [siteId]: m[siteId] === "on" ? "off" : "on" }));
  };

  const nodeIds = objects.map((o) => o.id);
  const hasOwn = objects.some((o) => o.instances.length > 0);
  const subtitle = objects.length === 1
    ? objects[0].name
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

  // План записи: отмеченные площадки — всем; нетронутые частичные — как было у каждого.
  // Без частичных — один запрос на всех; с ними — по запросу на каждый итоговый набор.
  const plan = (): { groups: WriteGroup[]; finalOf: Map<string, string[]> } => {
    const on = sites.filter((s) => marks[s.id] === "on").map((s) => s.id);
    const mixed = sites.filter((s) => marks[s.id] === "mixed").map((s) => s.id);
    const groups = new Map<string, WriteGroup>();
    const finalOf = new Map<string, string[]>();
    for (const o of objects) {
      const siteIds = [...on, ...mixed.filter((id) => o.instances.includes(id))];
      finalOf.set(o.id, siteIds);
      const key = [...siteIds].sort().join(",");
      let g = groups.get(key);
      if (!g) {
        g = { siteIds, nodeIds: [], clear: false };
        groups.set(key, g);
      }
      g.nodeIds.push(o.id);
      if (o.has_children && siteIds.length > 0) g.clear = true;
    }
    return { groups: [...groups.values()], finalOf };
  };
  const writeGroups = async (groups: WriteGroup[]) => {
    for (const g of groups) {
      if (g.clear) await deploymentApi.setPlacements(g.nodeIds, g.siteIds, { clearDescendants: true });
      else await deploymentApi.setPlacements(g.nodeIds, g.siteIds);
    }
  };
  // Применить: контейнер с объектами внутри на других площадках — сначала второй шаг.
  const apply = () => {
    const { groups, finalOf } = plan();
    const items: ContainerConflicts[] = [];
    for (const o of objects) {
      const siteIds = finalOf.get(o.id) ?? [];
      if (!o.has_children || siteIds.length === 0) continue;
      const conflicts = placementConflicts(all.data ?? NO_NODES, o.id, siteIds);
      if (conflicts.length > 0) items.push({ container: o, siteIds, conflicts });
    }
    if (items.length > 0) {
      setError(null);
      setStep({ groups, items });
      return;
    }
    void run(() => writeGroups(groups));
  };
  const removeAll = () => run(() => deploymentApi.setPlacements(nodeIds, []));

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

  // Второй шаг — вместо галочек в том же окне: что перезапишет размещение контейнера.
  if (step) {
    const one = step.items.length === 1 ? step.items[0] : null;
    return (
      <Modal onClose={onClose} boxStyle={{ width: 520, maxHeight: "86vh", overflowY: "auto" }}>
        {one ? (
          <>
            <DialogTitle lead={PLACE_LEAD}>{placeQuestion(one.container.name, one.siteIds.map(siteName))}</DialogTitle>
            <PlacementConflictList items={one.conflicts} />
          </>
        ) : (
          <>
            <DialogTitle lead={PLACE_LEAD_MANY}>Разместить контейнеры целиком?</DialogTitle>
            {step.items.map((it) => (
              <div key={it.container.id} className="placement-step-group">
                <p className="placement-step-head">
                  «{it.container.name}» → {it.siteIds.map((id) => `«${siteName(id)}»`).join(", ")}
                </p>
                <PlacementConflictList items={it.conflicts} />
              </div>
            ))}
          </>
        )}
        {error && <p style={errText} role="alert">{error}</p>}
        <div className="site-dialog-footer">
          <button type="button" style={primaryBtn} onClick={() => { void run(() => writeGroups(step.groups)); }} disabled={busy}>
            Разместить
          </button>
          <button type="button" style={secondaryBtn} onClick={() => { setStep(null); setError(null); }} disabled={busy}>
            Назад
          </button>
        </div>
      </Modal>
    );
  }

  // Состав проекта для предупреждения ещё грузится (или не загрузился) — ждёт только
  // «Применить»; «Убрать размещение» контейнер целиком не размещает и не ждёт.
  const allPending = needAll && all.data === null;

  return (
    <Modal onClose={onClose} boxStyle={{ width: 520, maxHeight: "86vh", overflowY: "auto" }}>
      <DialogTitle lead={subtitle}>Размещение</DialogTitle>
      <SiteTree
        sites={sites}
        expanded={expanded}
        onToggle={toggle}
        disabled={busy}
        create={{ busy, onOpen: () => setError(null), onSubmit: createSite }}
        row={(site) => {
          const mark = marks[site.id] ?? "off";
          const inherited = inheritedFrom(site.id);
          return (
            <label className="site-row-label">
              <input
                type="checkbox"
                checked={mark === "on"}
                ref={(el) => { if (el) el.indeterminate = mark === "mixed"; }}
                onChange={() => toggleMark(site.id)}
                disabled={busy}
              />
              <SiteRowTitle site={site} />
              {inherited && <span className="site-row-muted">унаследовано от «{inherited}»</span>}
            </label>
          );
        }}
      />

      {error && <p style={errText} role="alert">{error}</p>}
      {needAll && all.error !== null && (
        <p style={errText} role="alert">
          Не удалось проверить объекты внутри контейнера. {loadErrorText(all.error)}{" "}
          <button type="button" className="site-row-link" onClick={all.reload}>Повторить</button>
        </p>
      )}

      <div className="site-dialog-footer">
        <button type="button" style={primaryBtn} onClick={apply} disabled={busy || allPending}>
          Применить
        </button>
        <button type="button" style={secondaryBtn} onClick={() => { void removeAll(); }} disabled={busy || !hasOwn}>
          Убрать размещение
        </button>
        <button type="button" style={secondaryBtn} onClick={onClose} disabled={busy}>
          Отмена
        </button>
        {needAll && all.loading && <span className="placement-loading">Загрузка…</span>}
      </div>
    </Modal>
  );
}

// Пояснение второго шага, когда контейнеров с объектами на других площадках несколько.
const PLACE_LEAD_MANY = "Все их компоненты будут размещены там же, включая те, что сейчас стоят на других площадках:";
