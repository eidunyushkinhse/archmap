// Мелкие части панели ввоза: карточка активного архива вместо textarea и список
// замечаний. Вынесены из ImportPane, чтобы там остались только вход, статус и
// разбор остатка (Ф-E): панель и без того держит чипы, драг-н-дроп, память
// попыток агента и копирование замечаний.
import type { CSSProperties } from "react";

/** Список замечаний под панелью: первые шесть, остаток — счётчиком. */
export function ReportList({ title, items }: { title: string; items: string[] }) {
  return (
    <div style={{ marginTop: 6, fontSize: 12.5, color: "#b45309" }}>
      <div style={{ fontWeight: 600 }}>{title}</div>
      {items.slice(0, 6).map((s, i) => (
        <div key={i} style={{ marginTop: 2, color: "#475569" }}>{s}</div>
      ))}
      {items.length > 6 && <div style={{ marginTop: 2, color: "#475569" }}>…ещё {items.length - 6}</div>}
    </div>
  );
}

// Карточка активного архива вместо textarea: тело архива не правят — его читают.
// Кнопки «для агента» здесь нет принципиально (архив собирал экспорт).
export function ArchiveCard({ file, no, remarks }: { file: File; no: number; remarks: string[] }) {
  return (
    <div style={archiveCard}>
      <div style={{ fontSize: 13.5, fontWeight: 700, color: "#0f172a" }}>{file.name}</div>
      <div style={grayLine}>
        Вход {no} · {(file.size / 1024).toFixed(0)} КБ · полный архив знания
      </div>
      {remarks.length > 0 ? (
        <ReportList title="Замечания к архиву:" items={remarks} />
      ) : (
        <div style={grayLine}>К архиву замечаний нет.</div>
      )}
      <div style={{ ...grayLine, marginTop: 10 }}>
        Из архива приедут схемы логики, спеки, структуры БД и брокеров,
        конфигурация и процессы. Раскладка пересчитается заново.
      </div>
    </div>
  );
}

const grayLine: CSSProperties = { fontSize: 12.5, color: "#94a3b8", marginTop: 3 };
// Карточка архива занимает место textarea — панель не должна прыгать при смене чипа.
const archiveCard: CSSProperties = {
  height: 246, boxSizing: "border-box", overflowY: "auto",
  padding: "12px 14px", border: "1px solid #e2e8f0", borderRadius: 10, background: "#fff",
};
