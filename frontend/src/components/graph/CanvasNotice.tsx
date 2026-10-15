// Плашка-тост поверх холста: перегрузка, ступени бюджета, грязь стрелок, отказ записи
// расположения. Вид задаёт tone (классы lg-*-toast в LevelGraph.css), крестик — общий.
import type { ReactNode } from "react";

export default function CanvasNotice({ tone, role = "status", closeLabel, onClose, children }: {
  tone: "overload" | "budget" | "dirty";
  // alert — для отказа, который требует внимания; status — для предупреждений.
  role?: "status" | "alert";
  closeLabel: string;
  onClose: () => void;
  children: ReactNode;
}) {
  return (
    <div className={`lg-${tone}-toast`} role={role}>
      <span>{children}</span>
      <button className="lg-overload-close" onClick={onClose} aria-label={closeLabel}>✕</button>
    </div>
  );
}
