// Мелкая часть панели ввоза: список отчёта под итогом превью (одно-файловые конфликты
// слияния). Вынесена из ImportPane, чтобы там остались только входы, статус и разбор
// остатка (Ф-E). Вид — список замечаний нового языка (agentParts.css, как NoteList с
// пропом ds): заголовок цветом предупреждения, пункты тихим цветом.
import "../docsImport/agentParts.css";

/** Список строк отчёта под панелью: первые шесть, остаток — счётчиком. */
export function ReportList({ title, items }: { title: string; items: string[] }) {
  return (
    <div className="anl">
      <p className="anl-title">{title}</p>
      {items.slice(0, 6).map((s, i) => <p key={i} className="anl-item">{s}</p>)}
      {items.length > 6 && <p className="anl-item">и ещё {items.length - 6}</p>}
    </div>
  );
}
