// Форма площадки — общая для «Новой площадки» в окне «Размещение» и для добавления и
// правки в окне «Площадки»: имя, вид, технология, (описание), родитель. Родителем
// нельзя выбрать саму площадку и её вложенные — получился бы цикл.
import { useMemo, useState } from "react";
import type { KeyboardEvent } from "react";
import type { SiteKind, SiteOut } from "../../types";
import { SITE_KIND_LABEL, SITE_KIND_ORDER } from "../nodeTerms";
import { siteRows, sitePath, siteSubtree } from "./siteTree";
import "./deployment.css";
import "../../ui/smallButton.css";

export interface SiteFormValue {
  name: string;
  kind: SiteKind;
  technology: string;
  description: string;
  parentId: string; // "" — корневая площадка
}

interface Props {
  sites: readonly SiteOut[];
  initial?: Partial<SiteFormValue>;
  // правка: сама площадка (и её вложенные) в родители не годится
  editingId?: string;
  withDescription?: boolean;
  submitLabel: string;
  busy?: boolean;
  onSubmit: (value: SiteFormValue) => void;
  onCancel?: () => void;
}

export default function SiteForm({
  sites, initial, editingId, withDescription = false, submitLabel, busy = false, onSubmit, onCancel,
}: Props) {
  const [value, setValue] = useState<SiteFormValue>({
    name: initial?.name ?? "",
    kind: initial?.kind ?? "other",
    technology: initial?.technology ?? "",
    description: initial?.description ?? "",
    parentId: initial?.parentId ?? "",
  });
  const set = (patch: Partial<SiteFormValue>) => setValue((v) => ({ ...v, ...patch }));
  const parents = useMemo(() => {
    const banned = editingId ? siteSubtree(sites, editingId) : new Set<string>();
    return siteRows(sites)
      .filter((r) => !banned.has(r.site.id))
      .map((r) => ({ id: r.site.id, path: sitePath(sites, r.site.id) }));
  }, [sites, editingId]);
  const ready = value.name.trim().length > 0 && !busy;
  const submit = () => { if (ready) onSubmit(value); };
  // Enter в однострочном поле — то же, что кнопка формы (окно Enter не перехватывает).
  const onEnter = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key !== "Enter" || e.nativeEvent.isComposing) return;
    e.preventDefault();
    submit();
  };

  return (
    <div className="site-form">
      <label className="site-form-field">
        <span>Имя</span>
        <input
          data-autofocus
          value={value.name}
          onChange={(e) => set({ name: e.target.value })}
          onKeyDown={onEnter}
          maxLength={256}
        />
      </label>
      <label className="site-form-field">
        <span>Вид</span>
        <select value={value.kind} onChange={(e) => set({ kind: e.target.value as SiteKind })}>
          {SITE_KIND_ORDER.map((k) => <option key={k} value={k}>{SITE_KIND_LABEL[k]}</option>)}
        </select>
      </label>
      <label className="site-form-field">
        <span>Технология</span>
        <input
          value={value.technology}
          onChange={(e) => set({ technology: e.target.value })}
          onKeyDown={onEnter}
          maxLength={128}
          placeholder="AWS, k8s 1.30, Ubuntu 24.04"
        />
      </label>
      {withDescription && (
        <label className="site-form-field">
          <span>Описание</span>
          <textarea value={value.description} onChange={(e) => set({ description: e.target.value })} rows={2} />
        </label>
      )}
      <label className="site-form-field">
        <span>Внутри площадки</span>
        <select value={value.parentId} onChange={(e) => set({ parentId: e.target.value })}>
          <option value="">Нет, корневая</option>
          {parents.map((p) => <option key={p.id} value={p.id}>{p.path}</option>)}
        </select>
      </label>
      <div className="site-form-actions">
        <button type="button" className="btn-sm-primary" onClick={submit} disabled={!ready}>{submitLabel}</button>
        {onCancel && <button type="button" className="btn-soft" onClick={onCancel} disabled={busy}>Отмена</button>}
      </div>
    </div>
  );
}
