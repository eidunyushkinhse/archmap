// Статус СТРАНИЦЫ объекта у имени в шапке (docs/tasks/page-status.md): «В работе» или
// «Согласовано». Это не жизненный цикл узла (status existing/planned/deprecated). С
// редизайна (направление А) это не пилюля, а тихий текст с точкой; шеврон выпадашки
// виден при наведении. Имена классов np-approval* остались прежними.
//
// Кто ставит статус, решает элемент архитектуры (Р14 эпика docs/plan-c4-elements.md):
// у контейнера (в том числе с компонентами), компонента и «Пользователя» он свой, у
// системы складывается из вложенных объектов. Три вида:
// • не система + редактор — кнопка со стрелкой, выпадашка из двух значений, выбор зовёт onPick;
// • не система + читатель — неинтерактивная пилюля: статус меняет редактор проекта;
// • система (обе роли) — «Согласовано N из M», выпадашка-список единиц (вложенные
//   объекты любой глубины, кроме систем) с точками статуса, клик по строке открывает его
//   страницу.
// Элемент (element_effective) и вычисленный статус системы (approval_effective) приходят
// с сервера — здесь только показ: ни правила «все единицы согласованы», ни запроса
// компонент не знает.
import { useEffect, useState } from "react";
import type { Node, NodeApproval } from "../../types";
import { APPROVAL_HINT, APPROVAL_LABEL, APPROVAL_ORDER } from "../nodeTerms";
import "../../ui/ds.css";

interface Props {
  node: Node;
  isArchitect: boolean;
  // Единицы статуса системы — её потомки, кроме вложенных систем (контейнеры,
  // компоненты, «Пользователи»); null — ещё грузятся (или узел не система), [] — единиц
  // нет (пустая система): согласовывать нечего.
  units: Node[] | null;
  onNavigateNode: (id: string) => void;
  onPick: (value: NodeApproval) => void;
}

// Модификатор цвета: жёлтый «в работе», зелёный «согласовано».
const tone = (value: NodeApproval): string => (value === "approved" ? "ok" : "work");

function Dot({ value }: { value: NodeApproval }) {
  return <span className={`np-approval-dot np-approval-dot--${tone(value)}`} aria-hidden="true" />;
}

export default function ApprovalPill({ node, isArchitect, units, onNavigateNode, onPick }: Props) {
  const [open, setOpen] = useState(false);

  // Escape закрывает выпадашку. Клавишу не гасим (без preventDefault): нативный
  // <dialog> поверх страницы сам владеет своим Escape.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setOpen(false); };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open]);

  // Система — по элементу с сервера: её статус складывается из вложенных объектов.
  const isSystem = node.element_effective === "system";
  const shown = node.approval_effective;
  const pillClass = `np-approval np-approval--${tone(shown)}`;

  if (!isSystem && !isArchitect) {
    return (
      <span className={pillClass} title="Статус меняет редактор проекта">
        <Dot value={shown} />
        {APPROVAL_LABEL[shown]}
      </span>
    );
  }

  const approvedCount = units ? units.filter((c) => c.approval_effective === "approved").length : 0;
  // Система с единицами говорит счётом согласованных, без точки-разделителя.
  const label = isSystem && units && units.length > 0
    ? `Согласовано ${approvedCount} из ${units.length}`
    : APPROVAL_LABEL[shown];
  const close = () => setOpen(false);

  return (
    <div className="np-approval-wrap">
      <button
        type="button"
        className={pillClass}
        aria-expanded={open}
        title={isSystem ? "Статус системы складывается из вложенных объектов" : "Статус страницы"}
        onClick={() => setOpen((o) => !o)}
      >
        <Dot value={shown} />
        <span>{label}</span>
        <span className="np-approval-chev" aria-hidden="true">
          <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor"
            strokeWidth={2.4} strokeLinecap="round" strokeLinejoin="round"><path d="M6 9 L12 15 L18 9" /></svg>
        </span>
      </button>
      {open && (
        <>
          <div className="np-backdrop" onClick={close} />
          <div className="np-approval-menu ds-menu">
            {isSystem ? (
              units === null ? (
                <div className="ds-menu-head">Загрузка</div>
              ) : units.length === 0 ? (
                <div className="ds-menu-head">Согласовывать пока нечего</div>
              ) : (
                units.map((c) => (
                  <button
                    key={c.id}
                    type="button"
                    className="np-approval-row ds-menu-item"
                    onClick={() => { close(); onNavigateNode(c.id); }}
                  >
                    <Dot value={c.approval_effective} />
                    <span>{c.name}</span>
                  </button>
                ))
              )
            ) : (
              <>
                <div className="ds-menu-head">Статус страницы</div>
                {APPROVAL_ORDER.map((v) => {
                  const current = v === node.approval;
                  return (
                    <button
                      key={v}
                      type="button"
                      className={`np-approval-row ds-menu-item${current ? " is-current" : ""}`}
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
