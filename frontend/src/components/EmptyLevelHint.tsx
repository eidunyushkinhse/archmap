import type { CSSProperties } from "react";

interface Props {
  // показывать ли подсказку (на уровне ещё нет узлов)
  visible: boolean;
  // архитектору — подсказка про перетаскивание шаблона; зрителю — просто «пусто»
  isArchitect: boolean;
}

/**
 * Подсказка «на уровне нет узлов». Раньше замещала собой весь холст текстом —
 * теперь холст виден сразу (пустая канва с точками), а подсказка висит тостом в
 * правом верхнем углу и плавно уезжает за правый край после добавления первого узла.
 * ВСЕГДА смонтирована (за экраном при visible=false), чтобы проигрывалась анимация
 * уезда; position:fixed не обрезается overflow:hidden холста.
 */
export default function EmptyLevelHint({ visible, isArchitect }: Props) {
  return (
    <div
      style={{
        ...wrap,
        transform: visible ? "translateX(0)" : "translateX(calc(100% + 32px))",
      }}
      role="status"
    >
      <span style={icon} aria-hidden>📐</span>
      <span>
        {isArchitect ? (
          <>
            На этом уровне пока нет объектов.{" "}
            <span style={{ fontWeight: 600 }}>
              Перетащите сюда форму из раздела «Добавить объект».
            </span>
          </>
        ) : (
          "На этом уровне нет объектов."
        )}
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
  border: "1px solid #e5e7eb",
  borderLeft: "4px solid #6366f1",
  borderRadius: 8,
  boxShadow: "0 8px 24px rgba(0,0,0,.14)",
  color: "#374151",
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
