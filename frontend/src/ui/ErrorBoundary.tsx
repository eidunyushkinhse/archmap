import { Component } from "react";
import type { ReactNode } from "react";
// Только стили (ui/ds.css уже в начальном чанке вместе с экраном входа): граница ошибок
// не тянет за собой ни кода, ни хуков, ни ленивых модулей.
import "./ds.css";

// Граница ошибок рендера (единственный способ поймать исключение рендера в React —
// классовый компонент). Без неё любое исключение в дереве размонтирует ВСЁ приложение:
// белый экран без текста и без выхода. Здесь вместо упавшего поддерева — «Что-то
// сломалось» с двумя выходами: обновить страницу и уйти к списку проектов.
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

// Вид нового языка (ui/ds.css, ds-crash): белая область, колонка по центру без коробки.
// Только разметка и классы: граница обязана оставаться простой и надёжной.
function CrashCard({ error, onReset }: { error: Error; onReset: () => void }) {
  return (
    <div className="ds ds-crash" role="alert">
      <div className="ds-crash-col">
        <h2 className="ds-crash-title">Что-то сломалось</h2>
        <p className="ds-crash-lead">
          Страницу не удалось показать. Обновите её, а если не поможет, вернитесь к списку
          проектов и откройте страницу заново.
        </p>
        <code className="ds-crash-code">{error.message || error.name}</code>
        <div className="ds-fail-acts">
          <button type="button" className="ds-btn ds-btn--primary" onClick={() => window.location.reload()}>
            Обновить страницу
          </button>
          <button
            type="button"
            className="ds-btn"
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
