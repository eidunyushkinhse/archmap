// Иконки кнопок узла. Линейные, наследуют currentColor (на узле — text-цвет).
export function DrillInIcon({ size = 13 }: { size?: number }) {
  // Мотив курсора межуровневой связи (IntoCue): стрелка вниз в устье лунки —
  // «провалиться внутрь этого узла». Согласован со знаком, всплывающим при
  // протягивании связи на узел-зону входа.
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none"
      stroke="currentColor" strokeWidth={2.1} strokeLinecap="round" strokeLinejoin="round"
      style={{ display: "block" }} aria-hidden>
      <path d="M12 3 V13" />
      <path d="M8 9 L12 13.6 L16 9" />
      <path d="M5 17.5 a7 3 0 0 0 14 0" />
    </svg>
  );
}

export function MoreIcon({ size = 13 }: { size?: number }) {
  // Три точки — «открыть карточку со сведениями» (модалка детализации).
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor"
      style={{ display: "block" }} aria-hidden>
      <circle cx="5" cy="12" r="1.9" /><circle cx="12" cy="12" r="1.9" /><circle cx="19" cy="12" r="1.9" />
    </svg>
  );
}
