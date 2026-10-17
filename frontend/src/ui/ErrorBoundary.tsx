import { Component } from "react";
import type { CSSProperties, ReactNode } from "react";
import { primaryBtn, secondaryBtn } from "./styles";

// Граница ошибок рендера (единственный способ поймать исключение рендера в React —
// классовый компонент). Без неё любое исключение в дереве размонтирует ВСЁ приложение:
// белый экран без текста и без выхода. Здесь вместо упавшего поддерева — карточка
// «Что-то сломалось» с двумя выходами: обновить страницу и уйти к списку проектов.
// В журнал ошибка попадает через createRoot({ onCaughtError }) в main.tsx.
//
// resetKey — смена значения сбрасывает ошибку (App передаёт ключ маршрута: человек ушёл
// на другую страницу, и упавшее поддерево можно пробовать рисовать заново). Граница при
// этом НЕ перемонтируется — дети живут как прежде, пока ошибки нет.

interface Props {
  children: ReactNode;
  resetKey?: string;
  // Своя разметка вместо карточки (null — ничего не рисовать: так гасится упавший
  // необязательный слой, например обучающий тур).
  fallback?: ReactNode | ((error: Error, reset: () => void) => ReactNode);
}

interface State {
  error: Error | null;
}

export default class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: unknown): State {
    return { error: error instanceof Error ? error : new Error(String(error)) };
  }

  componentDidUpdate(prev: Props): void {
    if (this.state.error && prev.resetKey !== this.props.resetKey) this.reset();
  }

  reset = (): void => {
    this.setState({ error: null });
  };

  render(): ReactNode {
    const { error } = this.state;
    if (!error) return this.props.children;
    const { fallback } = this.props;
    if (fallback !== undefined) return typeof fallback === "function" ? fallback(error, this.reset) : fallback;
    return <CrashCard error={error} onReset={this.reset} />;
  }
}

function CrashCard({ error, onReset }: { error: Error; onReset: () => void }) {
  return (
    <div style={wrap} role="alert">
      <div style={card}>
        <h2 style={title}>Что-то сломалось</h2>
        <p style={lead}>
          Страница не смогла отрисоваться. Обновите её; если не поможет — вернитесь к списку
          проектов и откройте страницу заново.
        </p>
        <code style={detail}>{error.message || error.name}</code>
        <div style={actions}>
          <button type="button" style={primaryBtn} onClick={() => window.location.reload()}>
            Обновить страницу
          </button>
          <button
            type="button"
            style={secondaryBtn}
            onClick={() => {
              window.location.hash = "/projects";
              onReset();
            }}
          >
            К проектам
          </button>
        </div>
      </div>
    </div>
  );
}

const wrap: CSSProperties = {
  flex: 1,
  minHeight: "60vh",
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  padding: 24,
  background: "#f8fafc",
};
const card: CSSProperties = {
  width: 460,
  maxWidth: "100%",
  background: "#fff",
  border: "1px solid #e2e8f0",
  borderRadius: 13,
  boxShadow: "0 16px 40px rgba(15,23,42,.10)",
  padding: 24,
};
const title: CSSProperties = { margin: "0 0 10px", fontSize: 18, color: "#1e293b" };
const lead: CSSProperties = { margin: "0 0 12px", fontSize: 14, lineHeight: 1.5, color: "#475569" };
// Глобального стиля code нет (index.css) — вид кода целиком здесь.
const detail: CSSProperties = {
  display: "block",
  fontFamily: "ui-monospace, Consolas, monospace",
  fontSize: 12,
  lineHeight: "135%",
  padding: "4px 8px",
  borderRadius: 4,
  background: "#f4f3ec",
  color: "#94a3b8",
  whiteSpace: "pre-wrap",
  wordBreak: "break-word",
  marginBottom: 16,
};
const actions: CSSProperties = { display: "flex", gap: 8 };
