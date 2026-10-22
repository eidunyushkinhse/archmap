// Окно «Площадки» (docs/tasks/deployment-view.md §4): площадки проекта деревом с числом
// объектов, поставленных на каждую. Архитектору — добавить, изменить (CAS: чужая правка
// перечитывает окно) и удалить (с подтверждением; площадку с вложенными удалить нельзя,
// пока их не перенесут). Читателю — просмотр.
import { useMemo, useState } from "react";
import type { ReactNode } from "react";
import type { SiteOut } from "../../types";
import Modal from "../../ui/Modal";
import DialogTitle from "../../ui/DialogTitle";
import ConfirmDialog from "../../ui/ConfirmDialog";
import LoadError from "../../ui/LoadError";
import { SiteKindIcon } from "../../ui/icons";
import { errText } from "../../ui/styles";
import { plural } from "../../ui/plural";
import { loadErrorText } from "../../ui/loadErrorText";
import { useAsyncLoad } from "../../lib/useAsyncLoad";
import { deploymentApi } from "../../api/deployment";
import { isConflict } from "../../api/client";
import { limitMessage } from "../demo/demoLimits";
import { LimitText } from "../demo/DemoLimitToast";
import SiteForm, { type SiteFormValue } from "./SiteForm";
import { siteRows } from "./siteTree";
import "./deployment.css";

interface Props {
  isArchitect: boolean;
  onClose: () => void;
  // площадки изменились — хозяин перечитывает граф холста
  onChanged: () => void;
}

const objects = (n: number): string => `${n} ${plural(n, ["объект", "объекта", "объектов"])}`;
// Родительный падеж при числе: «Размещение 1 объекта / 3 объектов на ней будет снято».
const objectsOf = (n: number): string => `${n} ${plural(n, ["объекта", "объектов", "объектов"])}`;

export default function SitesDialog({ isArchitect, onClose, onChanged }: Props) {
  const list = useAsyncLoad("deployment-sites", () => deploymentApi.sites());
  const sites = useMemo(() => list.data ?? [], [list.data]);
  const rows = useMemo(() => siteRows(sites), [sites]);
  // Что сейчас правится: "new" — добавление, id — правка площадки, null — ничего.
  const [editing, setEditing] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<SiteOut | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ReactNode>(null);

  const done = () => {
    setEditing(null);
    list.reload();
    onChanged();
  };

  const create = async (v: SiteFormValue) => {
    setBusy(true);
    setError(null);
    try {
      await deploymentApi.createSite({
        name: v.name.trim(),
        kind: v.kind,
        technology: v.technology.trim() || null,
        description: v.description.trim() || null,
        parent_id: v.parentId || null,
      });
      done();
    } catch (e) {
      const limit = limitMessage(e, "site");
      setError(limit ? <LimitText message={limit} /> : loadErrorText(e));
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

  return (
    <>
      <Modal onClose={onClose} boxStyle={{ width: 620, maxHeight: "86vh", overflowY: "auto" }}>
        <DialogTitle>Площадки</DialogTitle>
        {list.error ? (
          <LoadError what="площадки" error={list.error} onRetry={list.reload} />
        ) : list.loading ? (
          <p className="site-tree-empty">Загрузка…</p>
        ) : (
          <div className="site-tree">
            {rows.length === 0 && <p className="site-tree-empty">Площадок пока нет</p>}
            {rows.map(({ site, depth, hasChildren }) => (
              editing === site.id ? (
                <div key={site.id} className="site-new" style={{ marginLeft: depth * 18 }}>
                  <SiteForm
                    sites={sites}
                    editingId={site.id}
                    withDescription
                    initial={{
                      name: site.name, kind: site.kind, technology: site.technology ?? "",
                      description: site.description ?? "", parentId: site.parent_id ?? "",
                    }}
                    submitLabel="Сохранить"
                    busy={busy}
                    onSubmit={(v) => { void update(site, v); }}
                    onCancel={() => setEditing(null)}
                  />
                </div>
              ) : (
                <div key={site.id} className="site-row" style={{ paddingLeft: 8 + depth * 18 }}>
                  <span className="site-row-icon"><SiteKindIcon kind={site.kind} size={14} /></span>
                  <span className="site-row-name">{site.name}</span>
                  {site.technology && <span className="site-row-muted">{site.technology}</span>}
                  <span style={{ flex: 1 }} />
                  {site.instance_count > 0 && <span className="site-row-muted site-row-count">{objects(site.instance_count)}</span>}
                  {isArchitect && (
                    <>
                      <button type="button" className="site-row-link" onClick={() => { setError(null); setEditing(site.id); }} disabled={busy}>
                        изменить
                      </button>
                      <button
                        type="button"
                        className="site-row-link"
                        onClick={() => { setError(null); setConfirmDelete(site); }}
                        disabled={busy || hasChildren}
                        title={hasChildren ? "Сначала перенесите вложенные площадки" : undefined}
                      >
                        удалить
                      </button>
                    </>
                  )}
                </div>
              )
            ))}
          </div>
        )}

        {isArchitect && !list.loading && !list.error && (
          editing === "new" ? (
            <div className="site-new">
              <SiteForm
                sites={sites}
                withDescription
                submitLabel="Добавить"
                busy={busy}
                onSubmit={(v) => { void create(v); }}
                onCancel={() => setEditing(null)}
              />
            </div>
          ) : (
            <button type="button" className="site-new-toggle" onClick={() => { setError(null); setEditing("new"); }} disabled={busy}>
              + Добавить площадку
            </button>
          )
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
