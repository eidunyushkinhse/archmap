import type { CSSProperties } from "react";

interface Props {
  // показывать ли уведомление (курсор с зажатым концом связи над не родным узлом)
  visible: boolean;
}

/**
 * Уведомление при попытке перепривязать конец существующей связи к не родному узлу
 * (к которому связь не относится). Висит в правом верхнем углу всё время, пока курсор
 * с зажатым концом над чужим узлом. Выезжает из-за правой границы экрана и уезжает
 * обратно — анимация по transform. ВСЕГДА смонтировано (за экраном при visible=false):
 * иначе уезжающая анимация не проигралась бы при размонтировании.
 */
export default function ReconnectBlockedToast({ visible }: Props) {
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
        Эту стрелку нельзя привязать к другому объекту.{" "}
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
