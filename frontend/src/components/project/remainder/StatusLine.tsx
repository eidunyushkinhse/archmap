// Строка статуса ввоза (§2 ТЗ) — одна строка вместо прежней сводки счётчиков:
// «сколько объектов приедет» решению не помогает, а «есть ли вопросы» помогает.
//
// Красное состояние живёт ТОЛЬКО здесь: внутри блока вопросов красного и
// янтарного нет вовсе. Под ним — первая ошибка и ссылка на её файл: чтобы
// починить, надо открыть тот вход, а не искать его глазами по чипам.
import { CheckIcon } from "../../../ui/icons";

export interface StatusError {
  /** Подпись чипа входа-виновника («2 · grafana.yaml»); null — виновника нет. */
  chipLabel: string | null;
  /** Индекс входа для переключения чипа (0-based). */
  chipIndex: number | null;
  /** Номер строки из текста ошибки, если он в нём был. */
  line: number | null;
  /** Текст ошибки — уже без «строка N:», если та вынесена в line. */
  text: string;
}

interface Props {
  state: "ok" | "ask" | "bad";
  error?: StatusError;
  onOpenFile?: (index: number) => void;
}

export default function StatusLine({ state, error, onOpenFile }: Props) {
  if (state === "ok") {
    return (
      <div className="rq-root rq-st rq-st--ok"><CheckIcon size={14} />Готово к импорту</div>
    );
  }
  if (state === "ask") {
    return (
      <div className="rq-root rq-st rq-st--ask">
        <span className="rq-st-mk">?</span>Есть вопросы
      </div>
    );
  }
  const чип = error?.chipLabel ?? null;
  return (
    <div className="rq-root">
      <div className="rq-st rq-st--bad"><span className="rq-st-mk">!</span>Что-то пошло не так</div>
      {error !== undefined && (
        <div className="rq-st-sub">
          {чип !== null ? (
            <>Проблема в файле <b>{чип}</b>{error.line !== null ? `. Строка ${error.line}: ` : ": "}{error.text}.</>
          ) : (
            <>{error.text}.</>
          )}
        </div>
      )}
      {чип !== null && error?.chipIndex !== null && error?.chipIndex !== undefined && (
        <div className="rq-st-sub">
          <button
            type="button"
            className="rq-link"
            onClick={() => { if (error.chipIndex !== null) onOpenFile?.(error.chipIndex); }}
          >
            Открыть файл {чип}
          </button>
        </div>
      )}
    </div>
  );
}
