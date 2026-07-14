import type { CSSProperties } from "react";

interface Props {
  // показывать ли подсказку (на уровне ещё нет узлов)
  visible: boolean;
  // архитектору — подсказка про перетаскивание шаблона; зрителю — просто «пусто»
  isArchitect: boolean;
}

/**
 * Подсказка «на уровне нет узлов». Раньше замещала собой весь холст текстом —
 * теперь холст виден сразу (пустая канва с точками), а подсказка живёт тостом в
 * рейле правого верхнего угла ХОЛСТА (toastRail в TreePage) и плавно уезжает за
 * его правый край после добавления первого узла. ВСЕГДА смонтирована (уехавшей
 * при visible=false), чтобы проигрывалась анимация уезда; overflow:hidden области
 * графа ОБРЕЗАЕТ сдвинутый тост — он скрывается за краем холста, а не выезжает
 * поверх шапки/правой панели (прежний position:fixed заслонял их кнопки).
 * Сдвиг 100% + 48px — с запасом на тень (blur 24), чтобы у кромки не оставалось
 * её следа.
 */
export default function EmptyLevelHint({ visible, isArchitect }: Props) {
  return (
    <div
      style={{
        ...wrap,
        transform: visible ? "translateX(0)" : "translateX(calc(100% + 48px))",
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
  // позиционирует рейл тостов холста (TreePage.toastRail) — сам тост лишь
  // сдвигается transform-ом за край области графа и обратно
  position: "relative",
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
