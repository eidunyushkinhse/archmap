// Стрелка «назад» в шапке экранов панели версий: из элемента — к версии, из версии —
// к списку.
import "./versions.css";

export default function BackButton({ onClick }: { onClick: () => void }) {
  return (
    <button type="button" className="vp-back" onClick={onClick} title="Назад" aria-label="Назад">←</button>
  );
}
