// Дерево площадок — одно на окна «Площадки» и «Размещение», чтобы они не разнились.
// У каждой строки шеврон (свёрнута по умолчанию); под раскрытой — вложенные площадки
// и «+», под корнями — свой «+». «+» раскрывает форму новой площадки на месте: родитель
// — та площадка, под которой нажали, поля «Внутри площадки» у создания нет. Что в
// строке после шеврона, решает хозяин: галочка («Размещение») или кнопки («Площадки»).
// Читателю «+» нет, и шеврон только у площадок с вложенными: раскрывать пустоту незачем.
import { Fragment, useMemo, useState } from "react";
import type { ReactNode } from "react";
import type { SiteOut } from "../../types";
import { ChevronIcon, PlusIcon, SiteKindIcon } from "../../ui/icons";
import SiteForm, { type SiteFormValue } from "./SiteForm";
import { siteForest, type SiteNode } from "./siteTree";
import "./deployment.css";

// Сдвиг вложенных строк: шеврон ребёнка — под иконкой родителя.
const indent = (depth: number): number => 4 + depth * 22;

export interface SiteRowInfo {
  depth: number;
  hasChildren: boolean;
}

export interface SiteCreate {
  busy: boolean;
  // нажали «+» — хозяин, например, гасит строку ошибки
  onOpen?: () => void;
  // true — площадка заведена, форма закрывается; false — отказ, форма остаётся
  onSubmit: (parentId: string | null, value: SiteFormValue) => Promise<boolean>;
}

interface Props {
  sites: readonly SiteOut[];
  expanded: ReadonlySet<string>;
  onToggle: (id: string) => void;
  // содержимое строки после шеврона
  row: (site: SiteOut, info: SiteRowInfo) => ReactNode;
  // строка, которую хозяин правит на месте: вместо неё — его форма
  editing?: { id: string; form: ReactNode } | null;
  // создание площадок («+»); не задано — читателю
  create?: SiteCreate;
  disabled?: boolean;
}

/** Иконка вида, имя и технология площадки — общее начало строки обоих окон. */
export function SiteRowTitle({ site }: { site: SiteOut }) {
  return (
    <>
      <span className="site-row-icon"><SiteKindIcon kind={site.kind} size={14} /></span>
      <span className="site-row-name">{site.name}</span>
      {site.technology && <span className="site-row-muted">{site.technology}</span>}
    </>
  );
}

export default function SiteTree({ sites, expanded, onToggle, row, editing, create, disabled = false }: Props) {
  const forest = useMemo(() => siteForest(sites), [sites]);
  // Под какой площадкой открыта форма новой (null — корневая); undefined — закрыта.
  const [creating, setCreating] = useState<{ parentId: string | null } | null>(null);

  const open = (parentId: string | null) => {
    create?.onOpen?.();
    setCreating({ parentId });
  };
  const submit = async (value: SiteFormValue) => {
    if (!create || !creating) return;
    if (await create.onSubmit(creating.parentId, value)) setCreating(null);
  };

  // «+» (или открытая форма) под списком: корневым или вложенных в parentId.
  const adder = (parentId: string | null, depth: number, parentName?: string): ReactNode => {
    if (!create) return null;
    if (creating && creating.parentId === parentId) {
      return (
        <div className="site-new" style={{ marginLeft: indent(depth) }}>
          <SiteForm
            submitLabel="Добавить"
            busy={create.busy}
            onSubmit={(v) => { void submit(v); }}
            onCancel={() => setCreating(null)}
          />
        </div>
      );
    }
    const label = parentName ? `Добавить площадку внутри «${parentName}»` : "Добавить площадку";
    return (
      <button
        type="button"
        className="site-add"
        style={{ paddingLeft: indent(depth) }}
        onClick={() => open(parentId)}
        disabled={disabled || create.busy}
        title={label}
        aria-label={label}
      >
        <span className="site-add-glyph"><PlusIcon size={14} /></span>
      </button>
    );
  };

  const renderNode = (n: SiteNode, depth: number): ReactNode => {
    const { site, children } = n;
    const hasChildren = children.length > 0;
    const expandable = hasChildren || create !== undefined;
    const isOpen = expandable && expanded.has(site.id);
    return (
      <Fragment key={site.id}>
        {editing?.id === site.id ? (
          <div className="site-new" style={{ marginLeft: indent(depth) }}>{editing.form}</div>
        ) : (
          <div className="site-row" style={{ paddingLeft: indent(depth) }}>
            {expandable ? (
              <button
                type="button"
                className={isOpen ? "site-row-chev site-row-chev--open" : "site-row-chev"}
                onClick={() => onToggle(site.id)}
                aria-expanded={isOpen}
                aria-label={`${isOpen ? "Свернуть" : "Развернуть"} «${site.name}»`}
                title={isOpen ? "Свернуть" : "Развернуть"}
              >
                <ChevronIcon size={12} />
              </button>
            ) : (
              <span className="site-row-chevspacer" />
            )}
            {row(site, { depth, hasChildren })}
          </div>
        )}
        {isOpen && (
          <>
            {children.map((c) => renderNode(c, depth + 1))}
            {adder(site.id, depth + 1, site.name)}
          </>
        )}
      </Fragment>
    );
  };

  return (
    <div className="site-tree" role="group" aria-label="Площадки">
      {forest.length === 0 && !creating && <p className="site-tree-empty">Площадок пока нет</p>}
      {forest.map((n) => renderNode(n, 0))}
      {adder(null, 0)}
    </div>
  );
}
