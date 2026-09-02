import type { CSSProperties } from "react";
import type { FamilyConflictOut } from "../../types";

/**
 * Споры содержимого единого ввоза (Ф2б, docs/plan-unified-import.md): два входа
 * описали ОДИН объект слитого дерева по-разному — доки-тёзки, две спеки OpenAPI,
 * параметр-тёзка с другим дефолтом. Байт-в-байт равные тела бэк дедуплицирует
 * молча, сюда приезжает только то, что рассудить может человек.
 *
 * Та же секция обслуживает ДОГРУЗКУ к живому проекту (Ф4): там одним из кандидатов
 * бывает само живое знание (current), и дефолт спора бэк ставит на него —
 * «оставить моё». Массовые действия («везде моё» / «везде из архивов») живут
 * снаружи: они про сценарий догрузки, а не про сам спор.
 *
 * Секция ничего не решает сама: выбор поднимается наверх (resolutions), в
 * применение он уезжает словарём «id спора → выбор». Предвыбор — дефолт бэка
 * (доки — «взять все», скаляры — первый кандидат), поэтому пользователь может не
 * трогать ничего и всё равно получить осмысленный результат.
 *
 * NB: тело кандидата раскрывается <details> ВНЕ <label> радио — иначе клик по
 * раскрывашке переключал бы выбор.
 */

interface Props {
  conflicts: FamilyConflictOut[];
  /** Выбор пользователя: id спора → «cand:<i>» либо «all». Нет записи — дефолт бэка. */
  resolutions: Record<string, string>;
  onResolve: (id: string, choice: string) => void;
}

// Русские имена семей фактов — те же слова, что на страницах объекта.
const FAMILY_LABEL: Record<FamilyConflictOut["family"], string> = {
  doc: "Схема логики",
  spec: "Спека API",
  table: "Таблица БД",
  channel: "Канал брокера",
  config: "Параметр конфигурации",
};

export default function ConflictSection({ conflicts, resolutions, onResolve }: Props) {
  if (conflicts.length === 0) return null;
  return (
    <div style={{ marginTop: 12 }}>
      <div style={titleStyle}>Споры содержимого ({conflicts.length})</div>
      <div style={hintStyle}>
        Одинаковые объекты описаны входами по-разному — выберите, чьё описание ехать должно.
      </div>
      {conflicts.map((c) => {
        const choice = resolutions[c.id] ?? c.default;
        return (
          <div key={c.id} style={cardStyle}>
            <div style={headStyle}>
              {FAMILY_LABEL[c.family]} · {c.key}
            </div>
            <div style={pathStyle}>{c.node_path}</div>
            {c.candidates.map((k, i) => {
              const value = `cand:${i}`;
              return (
                <div key={i} style={{ marginTop: 6 }}>
                  <label style={radioRow}>
                    <input
                      type="radio"
                      name={c.id}
                      value={value}
                      checked={choice === value}
                      onChange={() => onResolve(c.id, value)}
                    />
                    <span>
                      {/* Догрузка (Ф4): кандидат ЖИВОГО проекта отмечен НАЧЕРТАНИЕМ,
                          а не текстом — лейбл входа №0 бэк фиксирует говорящим
                          («Текущий проект»), и приписка к нему была бы дублем.
                          Метка нужна, чтобы своё знание не перетёрли по недосмотру. */}
                      <span style={k.current ? mineStyle : originStyle}>{k.origin_label}</span>
                      {" · "}
                      {k.summary}
                    </span>
                  </label>
                  <details style={detailsStyle}>
                    <summary style={summaryStyle}>Показать тело</summary>
                    <pre style={bodyStyle}>{k.body}</pre>
                    {k.truncated && <div style={truncStyle}>…показано начало</div>}
                  </details>
                </div>
              );
            })}
            {/* «Взять все» есть только у доков: схемы дополняют друг друга, тёзкам
                достанется номер. Скалярам (спека, параметр) брать всё некуда. */}
            {c.allow_all && (
              <label style={{ ...radioRow, marginTop: 6 }}>
                <input
                  type="radio"
                  name={c.id}
                  value="all"
                  checked={choice === "all"}
                  onChange={() => onResolve(c.id, "all")}
                />
                <span>Взять все (тёзкам — номер)</span>
              </label>
            )}
          </div>
        );
      })}
    </div>
  );
}

const titleStyle: CSSProperties = { fontSize: 13, fontWeight: 600, color: "#b45309" };
const hintStyle: CSSProperties = { fontSize: 12.5, color: "#64748b", marginTop: 2 };
const cardStyle: CSSProperties = {
  marginTop: 8, padding: "8px 10px", borderRadius: 10,
  border: "1px solid #e2e8f0", background: "#f8fafc",
};
const headStyle: CSSProperties = { fontSize: 12.5, fontWeight: 600, color: "#0f172a" };
const pathStyle: CSSProperties = { fontSize: 12, color: "#94a3b8", marginTop: 1 };
const radioRow: CSSProperties = {
  display: "flex", alignItems: "baseline", gap: 8,
  fontSize: 12.5, color: "#334155", cursor: "pointer",
};
const originStyle: CSSProperties = { fontWeight: 600 };
// Метка «моё» — начертанием: тем же тёмным акцентом, что заголовок карточки, чтобы
// кандидат живого проекта читался раньше привозных, а не спорил с ними цветом.
const mineStyle: CSSProperties = { fontWeight: 700, color: "#0f172a" };
const detailsStyle: CSSProperties = { marginLeft: 22 };
const summaryStyle: CSSProperties = { fontSize: 12, color: "#64748b", cursor: "pointer" };
const bodyStyle: CSSProperties = {
  margin: "4px 0 0", padding: "6px 8px", maxHeight: 160, overflow: "auto",
  borderRadius: 8, border: "1px solid #e2e8f0", background: "#fff",
  fontFamily: "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace",
  fontSize: 11.5, lineHeight: 1.45, color: "#0f172a", whiteSpace: "pre-wrap",
};
const truncStyle: CSSProperties = { fontSize: 11.5, color: "#94a3b8", marginTop: 2 };
