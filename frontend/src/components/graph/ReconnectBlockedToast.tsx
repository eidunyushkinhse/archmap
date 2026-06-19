import type { CSSProperties } from "react";

interface Props {
  // показывать ли уведомление (курсор с зажатым концом связи над не родным узлом)
  visible: boolean;
  // foreign — попытка привязать конец к чужому узлу; child — попытка «провалить» конец
  // в дочерний объект своего же узла-родителя (тоже запрещено: связи живут на одном уровне).
  variant?: "foreign" | "child";
}

const MESSAGE: Record<NonNullable<Props["variant"]>, string> = {
  foreign: "Эту стрелку нельзя привязать к другому объекту.",
  child: "Эту связь нельзя привязать к дочернему объекту.",
};

/**
 * Уведомление при попытке перепривязать конец существующей связи туда, куда нельзя:
 * к не родному узлу (variant=foreign) или внутрь дочернего объекта своего же узла
 * (variant=child). Висит в правом верхнем углу, пока активен запрет. Выезжает из-за
 * правой границы экрана и уезжает обратно — анимация по transform. ВСЕГДА смонтировано
 * (за экраном при visible=false): иначе уезжающая анимация не проиграла бы при размонтировании.
 */
export default function ReconnectBlockedToast({ visible, variant = "foreign" }: Props) {
  return (
    <div
      style={{
        ...wrap,
        transform: visible ? "translateX(0)" : "translateX(calc(100% + 32px))",
      }}
      role="status"
    >
      <span style={icon} aria-hidden>⛔</span>
      <span>
        {MESSAGE[variant]}{" "}
        <span style={{ fontWeight: 600 }}>Создайте новую</span>
      </span>
    </div>
  );
}

const wrap: CSSProperties = {
  position: "fixed",
  top: 16,
  right: 16,
  zIndex: 1001,
  maxWidth: 320,
  display: "flex",
  alignItems: "flex-start",
  gap: 10,
  padding: "12px 16px",
  background: "#fff",
  border: "1px solid #fecaca",
  borderLeft: "4px solid #dc2626",
  borderRadius: 8,
  boxShadow: "0 8px 24px rgba(0,0,0,.14)",
  color: "#991b1b",
  fontSize: 13,
  lineHeight: 1.4,
  pointerEvents: "none", // чисто информативное — не перехватывает указатель
  transition: "transform 0.28s ease",
};
const icon: CSSProperties = {
  fontSize: 16,
  flexShrink: 0,
  lineHeight: 1.2,
};
