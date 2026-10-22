// Пилюля статуса СТРАНИЦЫ объекта у имени в шапке (docs/tasks/page-status.md): «В работе»
// или «Согласовано». Это не жизненный цикл узла (status existing/planned/deprecated).
//
// Три вида:
// • лист + редактор — кнопка со стрелкой, выпадашка из двух значений, выбор зовёт onPick;
// • лист + читатель — неинтерактивная пилюля: статус меняет редактор проекта;
// • контейнер (обе роли) — пилюля со счётчиком «N из M», выпадашка-список детей с точками
//   статуса, клик по строке открывает страницу ребёнка.
// Вычисленный статус контейнера приходит с сервера (approval_effective) — здесь только
// показ: ни правила «все дети согласованы», ни запроса компонент не знает.
import { useEffect, useState } from "react";
import type { Node, NodeApproval } from "../../types";
import { APPROVAL_HINT, APPROVAL_LABEL, APPROVAL_ORDER } from "../nodeTerms";

interface Props {
  node: Node;
  isArchitect: boolean;
  // Непосредственные дети контейнера; null — ещё грузятся (или узел не контейнер).
  children: Node[] | null;
  onNavigateNode: (id: string) => void;
  onPick: (value: NodeApproval) => void;
}

// Модификатор цвета: жёлтый «в работе», зелёный «согласовано».
const tone = (value: NodeApproval): string => (value === "approved" ? "ok" : "work");

function Dot({ value }: { value: NodeApproval }) {
  return <span className={`np-approval-dot np-approval-dot--${tone(value)}`} aria-hidden="true" />;
}

export default function ApprovalPill({ node, isArchitect, children, onNavigateNode, onPick }: Props) {
  const [open, setOpen] = useState(false);

  // Escape закрывает выпадашку. Клавишу не гасим (без preventDefault): нативный
  // <dialog> поверх страницы сам владеет своим Escape.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setOpen(false); };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open]);

  // Контейнер — по наличию детей: его статус складывается из них.
  const isContainer = node.has_children;
  const shown = node.approval_effective;
  const pillClass = `np-approval np-approval--${tone(shown)}`;

  if (!isContainer && !isArchitect) {
    return (
      <span className={pillClass} title="Статус меняет редактор проекта">
        <Dot value={shown} />
        {APPROVAL_LABEL[shown]}
      </span>
    );
  }

  const approvedCount = children ? children.filter((c) => c.approval_effective === "approved").length : 0;
  const counter = isContainer && children ? ` · ${approvedCount} из ${children.length}` : "";
  const close = () => setOpen(false);

  return (
    <div className="np-approval-wrap">
      <button
        type="button"
        className={pillClass}
        aria-expanded={open}
        title={isContainer ? "Статус контейнера складывается из детей" : "Статус страницы"}
        onClick={() => setOpen((o) => !o)}
      >
        <Dot value={shown} />
        <span>{APPROVAL_LABEL[shown]}{counter}</span>
        <span className="np-approval-chev" aria-hidden="true">▾</span>
      </button>
      {open && (
        <>
          <div className="np-backdrop" onClick={close} />
          <div className="np-approval-menu">
            {isContainer ? (
              children === null ? (
                <div className="np-approval-head">Загрузка…</div>
              ) : (
                <>
                  <div className="np-approval-head">Согласовано {approvedCount} из {children.length}</div>
                  {children.map((c) => (
                    <button
                      key={c.id}
                      type="button"
                      className="np-approval-row"
                      onClick={() => { close(); onNavigateNode(c.id); }}
                    >
                      <Dot value={c.approval_effective} />
                      <span>{c.name}</span>
                    </button>
                  ))}
                </>
              )
            ) : (
              <>
                <div className="np-approval-head">Статус страницы</div>
                {APPROVAL_ORDER.map((v) => {
                  const current = v === node.approval;
                  return (
                    <button
                      key={v}
                      type="button"
                      className={`np-approval-row${current ? " is-current" : ""}`}
                      onClick={() => { close(); if (!current) onPick(v); }}
                    >
                      <Dot value={v} />
                      <span>
                        {APPROVAL_LABEL[v]}{" "}
                        <small>{APPROVAL_HINT[v]}</small>
                      </span>
                      {current && <span className="np-approval-tick" aria-label="текущий">✓</span>}
                    </button>
                  );
                })}
              </>
            )}
          </div>
        </>
      )}
    </div>
  );
}
