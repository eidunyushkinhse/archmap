// Окно «Площадки» (docs/tasks/deployment-view.md §4): площадки проекта деревом
// (SiteTree — то же дерево, что в окне «Размещение»). Архитектору — «+» в дереве
// (под вложенными площадки и под корнями), карандаш — изменить (CAS: чужая правка
// перечитывает окно), корзина — удалить (с подтверждением; площадку с вложенными
// удалить нельзя, пока их не перенесут). Читателю — просмотр.
import { useMemo, useState } from "react";
import type { ReactNode } from "react";
import type { SiteOut } from "../../types";
import Modal from "../../ui/Modal";
import DialogTitle from "../../ui/DialogTitle";
import ConfirmDialog from "../../ui/ConfirmDialog";
import LoadError from "../../ui/LoadError";
import { PencilIcon, TrashIcon } from "../../ui/icons";
import { errText } from "../../ui/styles";
import { plural } from "../../ui/plural";
import { loadErrorText } from "../../ui/loadErrorText";
import { useAsyncLoad } from "../../lib/useAsyncLoad";
import { deploymentApi } from "../../api/deployment";
import { isConflict } from "../../api/client";
import { limitMessage } from "../demo/demoLimits";
import { LimitText } from "../demo/DemoLimitToast";
import SiteForm, { type SiteFormValue } from "./SiteForm";
import SiteTree, { SiteRowTitle } from "./SiteTree";
import { useSiteExpansion } from "./useSiteExpansion";
import { siteAncestorIds } from "./siteTree";
import "./deployment.css";

interface Props {
  isArchitect: boolean;
  onClose: () => void;
  // площадки изменились — хозяин перечитывает граф холста
  onChanged: () => void;
}

// Родительный падеж при числе: «Размещение 1 объекта / 3 объектов на ней будет снято».
const objectsOf = (n: number): string => `${n} ${plural(n, ["объекта", "объектов", "объектов"])}`;

export default function SitesDialog({ isArchitect, onClose, onChanged }: Props) {
  const list = useAsyncLoad("deployment-sites", () => deploymentApi.sites());
  const sites = useMemo(() => list.data ?? [], [list.data]);
  const { expanded, toggle, expand } = useSiteExpansion();
  // id площадки, которая правится на месте (null — никакая).
  const [editing, setEditing] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<SiteOut | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ReactNode>(null);

  const done = () => {
    setEditing(null);
    list.reload();
    onChanged();
  };

  const create = async (parentId: string | null, v: SiteFormValue): Promise<boolean> => {
    setBusy(true);
    setError(null);
    try {
      await deploymentApi.createSite({
        name: v.name.trim(),
        kind: v.kind,
        technology: v.technology.trim() || null,
        description: v.description.trim() || null,
        parent_id: parentId,
      });
      done();
      return true;
    } catch (e) {
      const limit = limitMessage(e, "site");
      setError(limit ? <LimitText message={limit} /> : loadErrorText(e));
      return false;
    } finally {
      setBusy(false);
    }
  };

  const update = async (site: SiteOut, v: SiteFormValue) => {
    setBusy(true);
    setError(null);
    try {
      await deploymentApi.updateSite(site.id, {
        name: v.name.trim(),
        kind: v.kind,
        technology: v.technology.trim() || null,
        description: v.description.trim() || null,
        parent_id: v.parentId || null,
        base_version: site.version,
      });
      // Перенесли под другого родителя — раскрыть его и предков, иначе площадка
      // пропадёт из виду под свёрнутой веткой.
      if (v.parentId && v.parentId !== site.parent_id) expand([v.parentId, ...siteAncestorIds(sites, v.parentId)]);
      done();
    } catch (e) {
      if (isConflict(e)) {
        // Чужая правка: форма закрывается, окно показывает свежие данные.
        setError("Площадка изменена в другой сессии, окно перечитано");
        setEditing(null);
        list.reload();
      } else {
        setError(loadErrorText(e));
      }
    } finally {
      setBusy(false);
    }
  };

  const remove = async (site: SiteOut) => {
    setBusy(true);
    setError(null);
    try {
      await deploymentApi.deleteSite(site.id);
      setConfirmDelete(null);
      done();
    } catch (e) {
      setConfirmDelete(null);
      setError(loadErrorText(e));
    } finally {
      setBusy(false);
    }
  };

  const editingSite = editing ? sites.find((s) => s.id === editing) ?? null : null;

  return (
    <>
      <Modal onClose={onClose} boxStyle={{ width: 620, maxHeight: "86vh", overflowY: "auto" }}>
        <DialogTitle>Площадки</DialogTitle>
        {list.error ? (
          <LoadError what="площадки" error={list.error} onRetry={list.reload} />
        ) : list.loading ? (
          <p className="site-tree-empty">Загрузка…</p>
        ) : (
          <SiteTree
            sites={sites}
            expanded={expanded}
            onToggle={toggle}
            disabled={busy}
            create={isArchitect ? { busy, onOpen: () => setError(null), onSubmit: create } : undefined}
            editing={editingSite ? {
              id: editingSite.id,
              form: (
                <SiteForm
                  parent={{ sites, editingId: editingSite.id }}
                  initial={{
                    name: editingSite.name, kind: editingSite.kind, technology: editingSite.technology ?? "",
                    description: editingSite.description ?? "", parentId: editingSite.parent_id ?? "",
                  }}
                  submitLabel="Сохранить"
                  busy={busy}
                  onSubmit={(v) => { void update(editingSite, v); }}
                  onCancel={() => setEditing(null)}
                />
              ),
            } : null}
            row={(site, { hasChildren }) => (
              <>
                <SiteRowTitle site={site} />
                <span style={{ flex: 1 }} />
                {isArchitect && (
                  <>
                    <button
                      type="button"
                      className="site-row-btn"
                      onClick={() => { setError(null); setEditing(site.id); }}
                      disabled={busy}
                      title="Изменить"
                      aria-label={`Изменить площадку «${site.name}»`}
                    >
                      <PencilIcon size={15} />
                    </button>
                    <button
                      type="button"
                      className="site-row-btn"
                      onClick={() => { setError(null); setConfirmDelete(site); }}
                      disabled={busy || hasChildren}
                      title={hasChildren ? "Сначала перенесите вложенные площадки" : "Удалить"}
                      aria-label={`Удалить площадку «${site.name}»`}
                    >
                      <TrashIcon size={15} />
                    </button>
                  </>
                )}
              </>
            )}
          />
        )}

        {error && <p style={errText} role="alert">{error}</p>}
      </Modal>
      {/* Подтверждение — СИБЛИНГОМ окна, не внутри: вложенные <dialog> закрывались бы
          по Escape разом (ui/Modal, грабли нативного dialog). */}
      {confirmDelete && (
        <ConfirmDialog
          title={`Удалить площадку «${confirmDelete.name}»?`}
          lead={confirmDelete.instance_count > 0
            ? `Размещение ${objectsOf(confirmDelete.instance_count)} на ней будет снято.`
            : undefined}
          confirmLabel="Удалить"
          busy={busy}
          onConfirm={() => { void remove(confirmDelete); }}
          onCancel={() => setConfirmDelete(null)}
        />
      )}
    </>
  );
}
