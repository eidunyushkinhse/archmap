// Форма площадки — общая для создания в дереве площадок (SiteTree, оба окна) и для
// правки в окне «Площадки»: имя, вид, технология, описание. Поле «Внутри площадки» —
// только у правки (перенос под другого родителя): при создании родитель — та площадка,
// под которой нажали «+». Родителем нельзя выбрать саму площадку и её вложенные —
// получился бы цикл.
// Вид (редизайн, фаза 11): строки «подпись слева, значение справа» (ds-props, ui/ds.css),
// поля ds-input и списки ds-select; подписи связаны с полями. Рамку формы рисует место
// вызова (SiteTree, .site-new).
import { useEffect, useId, useMemo, useRef, useState } from "react";
import type { KeyboardEvent } from "react";
import type { SiteKind, SiteOut } from "../../types";
import { SITE_KIND_LABEL, SITE_KIND_ORDER } from "../nodeTerms";
import { ChevronDownIcon } from "../../ui/icons";
import { siteRows, sitePath, siteSubtree } from "./siteTree";
import "../../ui/ds.css";
import "./deployment.css";

export interface SiteFormValue {
  name: string;
  kind: SiteKind;
  technology: string;
  description: string;
  parentId: string; // "" — корневая площадка
}

interface Props {
  initial?: Partial<SiteFormValue>;
  // правка: поле «Внутри площадки»; сама площадка (и её вложенные) в родители не годится
  parent?: { sites: readonly SiteOut[]; editingId: string };
  submitLabel: string;
  busy?: boolean;
  onSubmit: (value: SiteFormValue) => void;
  onCancel?: () => void;
}

export default function SiteForm({ initial, parent, submitLabel, busy = false, onSubmit, onCancel }: Props) {
  const [value, setValue] = useState<SiteFormValue>({
    name: initial?.name ?? "",
    kind: initial?.kind ?? "other",
    technology: initial?.technology ?? "",
    description: initial?.description ?? "",
    parentId: initial?.parentId ?? "",
  });
  const set = (patch: Partial<SiteFormValue>) => setValue((v) => ({ ...v, ...patch }));
  const parents = useMemo(() => {
    if (!parent) return [];
    const banned = siteSubtree(parent.sites, parent.editingId);
    return siteRows(parent.sites)
      .filter((r) => !banned.has(r.site.id))
      .map((r) => ({ id: r.site.id, path: sitePath(parent.sites, r.site.id) }));
  }, [parent]);
  // Подписи связаны с полями по id: в окне бывает две формы сразу (правка и новая площадка).
  const uid = useId();
  const id = (field: string) => `${uid}-${field}`;
  // Форма раскрывается по «+» или карандашу в уже открытом окне — автофокус окна
  // (data-autofocus) на неё не сработает, фокус на имя ставим сами.
  const nameRef = useRef<HTMLInputElement>(null);
  useEffect(() => { nameRef.current?.focus(); }, []);
  const ready = value.name.trim().length > 0 && !busy;
  const submit = () => { if (ready) onSubmit(value); };
  // Enter в однострочном поле — то же, что кнопка формы (окно Enter не перехватывает).
  const onEnter = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key !== "Enter" || e.nativeEvent.isComposing) return;
    e.preventDefault();
    submit();
  };

  return (
    <>
      <dl className="ds-props">
        <div className="ds-prop">
          <dt className="ds-prop-term"><label htmlFor={id("name")}>Имя</label></dt>
          <dd className="ds-prop-value">
            <input
              id={id("name")}
              className="ds-input"
              ref={nameRef}
              data-autofocus
              value={value.name}
              onChange={(e) => set({ name: e.target.value })}
              onKeyDown={onEnter}
              maxLength={256}
            />
          </dd>
        </div>
        <div className="ds-prop">
          <dt className="ds-prop-term"><label htmlFor={id("kind")}>Вид</label></dt>
          <dd className="ds-prop-value">
            <span className="ds-select">
              <select id={id("kind")} value={value.kind} onChange={(e) => set({ kind: e.target.value as SiteKind })}>
                {SITE_KIND_ORDER.map((k) => <option key={k} value={k}>{SITE_KIND_LABEL[k]}</option>)}
              </select>
              <ChevronDownIcon />
            </span>
          </dd>
        </div>
        <div className="ds-prop">
          <dt className="ds-prop-term"><label htmlFor={id("tech")}>Технология</label></dt>
          <dd className="ds-prop-value">
            <input
              id={id("tech")}
              className="ds-input"
              value={value.technology}
              onChange={(e) => set({ technology: e.target.value })}
              onKeyDown={onEnter}
              maxLength={128}
              placeholder="AWS, k8s 1.30, Ubuntu 24.04"
            />
          </dd>
        </div>
        <div className="ds-prop">
          <dt className="ds-prop-term"><label htmlFor={id("desc")}>Описание</label></dt>
          <dd className="ds-prop-value">
            <textarea
              id={id("desc")}
              className="ds-input"
              value={value.description}
              onChange={(e) => set({ description: e.target.value })}
              rows={2}
            />
          </dd>
        </div>
        {parent && (
          <div className="ds-prop">
            <dt className="ds-prop-term"><label htmlFor={id("parent")}>Внутри площадки</label></dt>
            <dd className="ds-prop-value">
              <span className="ds-select">
                <select id={id("parent")} value={value.parentId} onChange={(e) => set({ parentId: e.target.value })}>
                  <option value="">Нет, корневая</option>
                  {parents.map((p) => <option key={p.id} value={p.id}>{p.path}</option>)}
                </select>
                <ChevronDownIcon />
              </span>
            </dd>
          </div>
        )}
      </dl>
      <div className="site-form-actions">
        <button type="button" className="ds-btn ds-btn--primary" onClick={submit} disabled={!ready}>{submitLabel}</button>
        {onCancel && <button type="button" className="ds-btn" onClick={onCancel} disabled={busy}>Отмена</button>}
      </div>
    </>
  );
}
