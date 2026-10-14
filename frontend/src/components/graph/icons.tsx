// Иконки кнопок узла. Линейные, наследуют currentColor (на узле — text-цвет).
export function DrillInIcon({ size = 13 }: { size?: number }) {
  // «Ветвь в потомка» — линия уходит вправо и спускается стрелкой на уровень ниже.
  // Раньше был мотив «стрелка вниз в лунку», но он путался со стандартным «Скачать»;
  // drop-cue лунки (IntoCue в nodes.tsx) намеренно остался лункой.
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none"
      stroke="currentColor" strokeWidth={2.1} strokeLinecap="round" strokeLinejoin="round"
      style={{ display: "block" }} aria-hidden>
      <path d="M6 3 V11 a3 3 0 0 0 3 3 H18" />
      <path d="M14 10 L18.5 14 L14 18" />
    </svg>
  );
}
