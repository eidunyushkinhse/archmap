// Окно «Размещение» (docs/tasks/deployment-view.md §6): где крутятся выбранные объекты.
// Площадки деревом с галочками — НАБОР экземпляров каждого объекта целиком. Галочка
// стоит, если СВОЙ экземпляр на площадке есть у всех выбранных; частичная — у части;
// у площадки, где размещение только унаследовано, — подпись «унаследовано от «X»».
// Частичную галочку, которую не трогали, применение сохраняет как есть у каждого
// объекта. «Новая площадка» заводится тут же и сразу отмечена.
import { useMemo, useState } from "react";
import type { ReactNode } from "react";
import type { DeploymentNode, SiteOut } from "../../types";
import Modal from "../../ui/Modal";
import DialogTitle from "../../ui/DialogTitle";
import { SiteKindIcon } from "../../ui/icons";
import { errText, primaryBtn, secondaryBtn } from "../../ui/styles";
import { plural } from "../../ui/plural";
import { loadErrorText } from "../../ui/loadErrorText";
import { deploymentApi } from "../../api/deployment";
import { limitMessage } from "../demo/demoLimits";
import { LimitText } from "../demo/DemoLimitToast";
import SiteForm, { type SiteFormValue } from "./SiteForm";
import { siteRows } from "./siteTree";
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

// Состояние галочки площадки по своим экземплярам выбранных объектов.
function initialMarks(objects: DeploymentNode[], sites: SiteOut[]): Record<string, Mark> {
  const out: Record<string, Mark> = {};
  for (const s of sites) {
    const own = objects.filter((o) => o.instances.includes(s.id)).length;
    out[s.id] = own === 0 ? "off" : own === objects.length ? "on" : "mixed";
  }
  return out;
}

export default function PlacementDialog({ objects, sites: initialSites, onClose, onApplied, onSitesChanged }: Props) {
  const [sites, setSites] = useState<SiteOut[]>(initialSites);
  const [marks, setMarks] = useState<Record<string, Mark>>(() => initialMarks(objects, initialSites));
  const [creating, setCreating] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ReactNode>(null);
  const rows = useMemo(() => siteRows(sites), [sites]);

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

  const toggle = (siteId: string) => {
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

  // Применить: отмеченные площадки — всем; нетронутые частичные — как было у каждого.
  // Без частичных — один запрос на всех; с ними — по запросу на каждый итоговый набор.
  const apply = () => run(async () => {
    const on = sites.filter((s) => marks[s.id] === "on").map((s) => s.id);
    const mixed = sites.filter((s) => marks[s.id] === "mixed").map((s) => s.id);
    if (mixed.length === 0) {
      await deploymentApi.setPlacements(nodeIds, on);
      return;
    }
    const groups = new Map<string, { siteIds: string[]; nodeIds: string[] }>();
    for (const o of objects) {
      const siteIds = [...on, ...mixed.filter((id) => o.instances.includes(id))];
      const key = [...siteIds].sort().join(",");
      const g = groups.get(key);
      if (g) g.nodeIds.push(o.id);
      else groups.set(key, { siteIds, nodeIds: [o.id] });
    }
    for (const g of groups.values()) await deploymentApi.setPlacements(g.nodeIds, g.siteIds);
  });
  const removeAll = () => run(() => deploymentApi.setPlacements(nodeIds, []));

  const createSite = async (v: SiteFormValue) => {
    setBusy(true);
    setError(null);
    try {
      const created = await deploymentApi.createSite({
        name: v.name.trim(),
        kind: v.kind,
        technology: v.technology.trim() || null,
        parent_id: v.parentId || null,
      });
      setSites((s) => [...s, created]);
      setMarks((m) => ({ ...m, [created.id]: "on" }));
      setCreating(false);
      onSitesChanged();
    } catch (e) {
      const limit = limitMessage(e, "site");
      setError(limit ? <LimitText message={limit} /> : loadErrorText(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal onClose={onClose} boxStyle={{ width: 520, maxHeight: "86vh", overflowY: "auto" }}>
      <DialogTitle lead={subtitle}>Размещение</DialogTitle>
      <div className="site-tree" role="group" aria-label="Площадки">
        {rows.length === 0 && <p className="site-tree-empty">Площадок пока нет</p>}
        {rows.map(({ site, depth }) => {
          const mark = marks[site.id] ?? "off";
          const inherited = inheritedFrom(site.id);
          return (
            <label key={site.id} className="site-row" style={{ paddingLeft: 8 + depth * 18 }}>
              <input
                type="checkbox"
                checked={mark === "on"}
                ref={(el) => { if (el) el.indeterminate = mark === "mixed"; }}
                onChange={() => toggle(site.id)}
                disabled={busy}
              />
              <span className="site-row-icon"><SiteKindIcon kind={site.kind} size={14} /></span>
              <span className="site-row-name">{site.name}</span>
              {site.technology && <span className="site-row-muted">{site.technology}</span>}
              {inherited && <span className="site-row-muted">унаследовано от «{inherited}»</span>}
            </label>
          );
        })}
      </div>

      {creating ? (
        <div className="site-new">
          <SiteForm
            sites={sites}
            submitLabel="Добавить"
            busy={busy}
            onSubmit={(v) => { void createSite(v); }}
            onCancel={() => setCreating(false)}
          />
        </div>
      ) : (
        <button type="button" className="site-new-toggle" onClick={() => setCreating(true)} disabled={busy}>
          + Новая площадка
        </button>
      )}

      {error && <p style={errText} role="alert">{error}</p>}

      <div className="site-dialog-footer">
        <button type="button" style={primaryBtn} onClick={() => { void apply(); }} disabled={busy}>
          Применить
        </button>
        <button type="button" style={secondaryBtn} onClick={() => { void removeAll(); }} disabled={busy || !hasOwn}>
          Убрать размещение
        </button>
        <button type="button" style={secondaryBtn} onClick={onClose} disabled={busy}>
          Отмена
        </button>
      </div>
    </Modal>
  );
}
