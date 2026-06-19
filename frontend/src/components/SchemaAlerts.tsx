import { useEffect, useRef, useState } from "react";
import type { CSSProperties, ReactNode } from "react";
import type { SchemaAlerts as Alerts } from "../types";
import "./schemaAlerts.css";

/**
 * Индикатор незавершённости схемы для архитектора (редизайн «Вариант 1 · Минимал-знак»).
 *
 *  • Есть активные алерты → в правом верхнем углу схемы — компактный круглый
 *    янтарный знак «!» с бабл-счётчиком. При появлении и при росте числа замечаний
 *    знак коротко пульсирует (3 цикла), привлекая внимание без постоянного шума.
 *  • Клик раскрывает компактную панель с тремя категориями. Каждый пункт
 *    кликабелен и ведёт к объекту/связи на схеме (через onLocate — поведение
 *    перехода реализует вызывающая сторона).
 *  • Когда устранено последнее замечание (total: >0 → 0) — на ~2.5 с всплывает
 *    зелёный тост «Схема завершена» и уезжает вправо за край. Постоянно на схеме
 *    он НЕ живёт.
 *
 * Категории (формулировки на «объект», не «узел»):
 *  1) Объекты без связей — атомарные объекты без единой связи;
 *  2) Связи в промежуточный объект — связь упирается в контейнер, а не в атомарный;
 *  3) Изолированные группы — схема распалась на ≥2 несвязанных кластера.
 * Алерты глобальные, считаются на бэке — здесь только отображение.
 */

type LocateTarget =
  | { kind: "node"; id: string }
  | { kind: "edge"; id: string }
  | { kind: "group"; ids: string[] };

interface Props {
  alerts: Alerts;
  // Переход к проблемному объекту/связи на схеме (pan + подсветка) — реализуется
  // вызывающей стороной (TreePage). Если не передан — пункты не кликабельны.
  onLocate?: (target: LocateTarget) => void;
}

const TOAST_HOLD = 2500; // сколько тост висит, мс
const TOAST_EXIT = 260; // длительность уезда вправо, мс (синхронно с CSS)

/* Восклицательный знак в треугольнике */
function WarningIcon({ size = 20, sw = 2.2 }: { size?: number; sw?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={sw} strokeLinecap="round" strokeLinejoin="round">
      <path d="M10.3 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.7 3.86a2 2 0 0 0-3.4 0z" />
      <line x1="12" y1="9.2" x2="12" y2="13.2" /><line x1="12" y1="16.6" x2="12.01" y2="16.6" />
    </svg>
  );
}
const CheckIcon = ({ size = 15, sw = 2.2 }: { size?: number; sw?: number }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={sw} strokeLinecap="round" strokeLinejoin="round"><path d="M5 12.5l4.5 4.5L19 6.5" /></svg>
);

/* Иконки категорий (16px, line) */
const sIco = { fill: "none", stroke: "currentColor", strokeWidth: 1.5, strokeLinecap: "round" as const, strokeLinejoin: "round" as const };
const IcoUnlink = (s = 13) => <svg width={s} height={s} viewBox="0 0 16 16" {...sIco}><circle cx="8" cy="8" r="4.2" /><path d="M3.2 12.8 12.8 3.2" /></svg>;
const IcoArrowBox = (s = 13) => <svg width={s} height={s} viewBox="0 0 16 16" {...sIco}><rect x="9" y="3.4" width="3.8" height="9.2" rx="1" /><path d="M2 8h5.2" /><path d="M5.2 5.6 7.6 8l-2.4 2.4" /></svg>;
const IcoScatter = (s = 13) => <svg width={s} height={s} viewBox="0 0 16 16" {...sIco}><circle cx="4.2" cy="5" r="1.9" /><circle cx="11.6" cy="4.4" r="1.9" /><circle cx="8" cy="11.4" r="1.9" /></svg>;
const IcoLocate = (s = 14) => <svg width={s} height={s} viewBox="0 0 16 16" {...sIco}><circle cx="8" cy="8" r="3" /><path d="M8 1v2.2M8 12.8V15M1 8h2.2M12.8 8H15" /></svg>;

export default function SchemaAlerts({ alerts, onLocate }: Props) {
  const [open, setOpen] = useState(false);
  const [pulseKey, setPulseKey] = useState(0);
  const [toast, setToast] = useState(false);
  const [leaving, setLeaving] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  const disconnected = alerts.disconnected_nodes;
  const intermediate = alerts.intermediate_edges;
  const isolated = alerts.isolated_groups;
  // Изолированные группы — это ОДНА проблема связности, проявляющаяся как «не хватает
  // (групп − 1) связей»: 2 группы → 1 недостающая связь, 3 → 2 и т.д. Поэтому в счётчик
  // идёт groups − 1, а не само число групп (иначе цифра завышает число проблем).
  const isolatedProblems = Math.max(0, isolated.length - 1);
  const total = disconnected.length + intermediate.length + isolatedProblems;

  // Отслеживаем переходы total: рост → пульс; обнуление (>0 → 0) → тост
  const prevTotal = useRef(total);
  useEffect(() => {
    const prev = prevTotal.current;
    prevTotal.current = total;
    if (prev > 0 && total === 0) {
      setOpen(false);
      setLeaving(false);
      setToast(true);
      const t1 = setTimeout(() => setLeaving(true), TOAST_HOLD);
      const t2 = setTimeout(() => setToast(false), TOAST_HOLD + TOAST_EXIT);
      return () => { clearTimeout(t1); clearTimeout(t2); };
    }
    if (total > prev) setPulseKey((k) => k + 1); // новое замечание — пульс
  }, [total]);

  // Закрытие панели по клику вне и по Escape
  useEffect(() => {
    if (!open) return;
    function onDown(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as globalThis.Node)) setOpen(false);
    }
    function onKey(e: KeyboardEvent) { if (e.key === "Escape") setOpen(false); }
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  // Ничего активного и тост отыграл — не рендерим
  if (total === 0 && !toast) return null;

  // Состояние «схема завершена» — транзиентный тост
  if (total === 0) {
    return (
      <div style={wrap}>
        <div className={"sa-toast" + (leaving ? " sa-toast--leave" : "")} style={toastBox} role="status">
          <span style={toastCheck}><CheckIcon /></span>
          <span style={{ fontSize: 13.5, fontWeight: 600, color: "#047857" }}>Схема завершена</span>
        </div>
      </div>
    );
  }

  return (
    <div ref={ref} style={wrap}>
      <button
        style={badge}
        onClick={() => setOpen((o) => !o)}
        title="Незавершённость схемы — открыть детали"
        aria-label={`Незавершённость схемы: ${total}`}
        aria-expanded={open}
      >
        <span key={pulseKey} className="sa-ring" aria-hidden="true" />
        <WarningIcon />
        <span style={count}>{total}</span>
      </button>

      {open && (
        <div className="sa-panel" style={menu}>
          <div style={menuHead}>
            <span style={{ color: "#d97706", display: "flex" }}><WarningIcon size={16} /></span>
            <span style={{ fontSize: 13, fontWeight: 700, color: "#111827" }}>Незавершённость схемы</span>
            <span style={totalChip}>{total}</span>
          </div>

          <Section icon={IcoUnlink(13)} title="Объекты без связей" count={disconnected.length}>
            {disconnected.map((d) => (
              <Item key={d.node_id} onClick={onLocate && (() => onLocate({ kind: "node", id: d.node_id }))}>
                {d.node_name}
              </Item>
            ))}
          </Section>

          <Section icon={IcoArrowBox(13)} title="Связи в промежуточный объект" count={intermediate.length}>
            {intermediate.map((e) => (
              <Item key={e.edge_id} onClick={onLocate && (() => onLocate({ kind: "edge", id: e.edge_id }))}>
                <span style={{ display: "inline-flex", alignItems: "center", gap: 5, flexWrap: "wrap" }}>
                  <span style={e.source_is_intermediate ? badEnd : undefined}>{e.source_name}</span>
                  <span style={{ color: "#9ca3af" }}>→</span>
                  <span style={e.target_is_intermediate ? badEnd : undefined}>{e.target_name}</span>
                </span>
              </Item>
            ))}
          </Section>

          <Section icon={IcoScatter(13)} title="Изолированные группы" count={isolatedProblems}>
            {isolated.map((grp, i) => (
              <Item key={i} onClick={onLocate && (() => onLocate({ kind: "group", ids: grp.node_ids }))}>
                <span style={{ color: "#6b7280", fontWeight: 600 }}>Группа {i + 1}:</span> {grp.node_names.join(", ")}
              </Item>
            ))}
          </Section>
        </div>
      )}
    </div>
  );
}

/* секция категории: шапка (иконка-чип + заголовок + счётчик) + строки */
function Section({ icon, title, count, children }: { icon: ReactNode; title: string; count: number; children: ReactNode }) {
  if (count === 0) return null; // пустые категории не показываем
  return (
    <div style={section}>
      <div style={sectionHead}>
        <span style={iconChip}>{icon}</span>
        <span style={{ fontSize: 12.5, fontWeight: 600, color: "#374151" }}>{title}</span>
        <span style={{ marginLeft: "auto", fontSize: 12, fontWeight: 700, color: "#9ca3af" }}>{count}</span>
      </div>
      {children}
    </div>
  );
}

/* строка-пункт: hover-подсветка + «прицел» перехода. Кликабельна, если есть onClick */
function Item({ children, onClick }: { children: ReactNode; onClick?: (() => void) | false | undefined }) {
  return (
    <div
      className={"sa-item" + (onClick ? " sa-item--clickable" : "")}
      onClick={onClick || undefined}
      role={onClick ? "button" : undefined}
      tabIndex={onClick ? 0 : undefined}
      onKeyDown={onClick ? (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onClick(); } } : undefined}
    >
      <span style={{ flex: 1, minWidth: 0, lineHeight: 1.35 }}>{children}</span>
      {onClick && <span className="sa-loc" title="Показать на схеме">{IcoLocate(14)}</span>}
    </div>
  );
}

/* --------------------------------- стили --------------------------------- */
const wrap: CSSProperties = { position: "absolute", top: 12, right: 12, zIndex: 6 };
const badge: CSSProperties = {
  position: "relative", width: 42, height: 42, borderRadius: 21, background: "#f59e0b",
  border: "none", color: "#fff", display: "flex", alignItems: "center", justifyContent: "center",
  cursor: "pointer", boxShadow: "0 2px 8px rgba(0,0,0,.18)",
};
const count: CSSProperties = {
  position: "absolute", top: -5, right: -5, minWidth: 19, height: 19, padding: "0 5px",
  borderRadius: 10, background: "#fff", color: "#b45309", border: "1.5px solid #f59e0b",
  fontSize: 11, fontWeight: 800, display: "flex", alignItems: "center", justifyContent: "center", boxSizing: "border-box",
};
const menu: CSSProperties = {
  position: "absolute", top: "calc(100% + 8px)", right: 0, width: 296, maxHeight: 460, overflowY: "auto",
  background: "#fff", border: "1px solid #e5e7eb", borderRadius: 12, boxShadow: "0 12px 32px rgba(17,24,39,.16)", padding: "0 0 6px",
};
const menuHead: CSSProperties = {
  display: "flex", alignItems: "center", gap: 8, padding: "12px 14px 11px", borderBottom: "1px solid #f3f4f6",
};
const totalChip: CSSProperties = {
  marginLeft: "auto", fontSize: 12, fontWeight: 800, color: "#b45309", background: "#fef3c7", borderRadius: 999, padding: "2px 8px",
};
const section: CSSProperties = { padding: "8px 6px 6px", borderTop: "1px solid #f3f4f6" };
const sectionHead: CSSProperties = { display: "flex", alignItems: "center", gap: 8, padding: "0 8px 4px" };
const iconChip: CSSProperties = {
  width: 22, height: 22, borderRadius: 7, background: "#fef3c7", color: "#d97706",
  display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0,
};
// подсветка конца-нарушителя (промежуточного объекта) в строке связи
const badEnd: CSSProperties = { color: "#b45309", fontWeight: 600 };
const toastBox: CSSProperties = {
  display: "flex", alignItems: "center", gap: 9, background: "#fff", border: "1px solid #a7f3d0",
  borderRadius: 12, padding: "9px 14px 9px 11px", boxShadow: "0 8px 24px rgba(5,150,105,.16)",
};
const toastCheck: CSSProperties = {
  width: 24, height: 24, borderRadius: 12, background: "#10b981", color: "#fff",
  display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0,
};
