// Строка статуса ввоза (§2 ТЗ) — одна строка вместо прежней сводки счётчиков:
// «сколько объектов приедет» решению не помогает, а «всё ли сошлось» помогает.
//
// Среднее состояние зовётся «Не всё сошлось идеально» (Ф2г-2), а не «Есть вопросы»:
// оно бывает и без единого вопроса — одними пунктами свёртки «Придется подправить
// вручную». «Есть вопросы» тогда противоречило бы экрану, а «Готово к импорту»
// обещало бы, что всё хорошо.
//
// Красное состояние живёт ТОЛЬКО здесь: внутри блока вопросов красного и
// янтарного нет вовсе, карточки ошибок у файла тоже нет (правка Ф2г). Под ним —
// ошибка и ссылка на её файл: чтобы починить, надо открыть тот вход, а не искать
// его глазами по чипам. Ошибок несколько (два битых файла, несколько ошибок в
// одном, ошибки слитой схемы) — маркированным списком, пункт на ошибку, в том же
// виде, что свёртка «Придется подправить вручную».
import { CheckIcon } from "../../../ui/icons";
import "./remainder.css";

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
  /** Все ошибки отказа — в порядке входов, затем ошибки слитой схемы. */
  errors?: StatusError[];
  onOpenFile?: (index: number) => void;
}

/** «Строка 3: текст.» / «текст.» — хвост сообщения после адреса файла. */
const lineAndText = (e: StatusError): string =>
  `${e.line !== null ? `Строка ${e.line}: ` : ""}${e.text}.`;

export default function StatusLine({ state, errors = [], onOpenFile }: Props) {
  if (state === "ok") {
    return (
      <div className="rq-root rq-st rq-st--ok"><CheckIcon size={14} />Готово к импорту</div>
    );
  }
  if (state === "ask") {
    return (
      <div className="rq-root rq-st rq-st--ask">
        <span className="rq-st-mk">?</span>Не всё сошлось идеально
      </div>
    );
  }
  return (
    <div className="rq-root">
      <div className="rq-st rq-st--bad"><span className="rq-st-mk">!</span>Что-то пошло не так</div>
      {errors.length === 1 && <OneError error={errors[0]} onOpenFile={onOpenFile} />}
      {errors.length > 1 && (
        <div className="rq-st-sub">
          <ul className="rq-ul">
            {errors.map((e, i) => (
              <li key={i}>
                {e.chipLabel !== null ? (
                  <>
                    {e.chipIndex !== null && onOpenFile !== undefined ? (
                      <button
                        type="button"
                        className="rq-link rq-link--in"
                        onClick={() => { if (e.chipIndex !== null) onOpenFile(e.chipIndex); }}
                      >
                        Файл {e.chipLabel}
                      </button>
                    ) : (
                      <b>Файл {e.chipLabel}</b>
                    )}
                    {". "}{lineAndText(e)}
                  </>
                ) : lineAndText(e)}
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

/** Одна ошибка — как было до списка: предложение и отдельная ссылка на файл. */
function OneError({ error, onOpenFile }: { error: StatusError; onOpenFile?: (index: number) => void }) {
  const чип = error.chipLabel;
  return (
    <>
      <div className="rq-st-sub">
        {чип !== null ? (
          <>Проблема в файле <b>{чип}</b>{error.line !== null ? `. Строка ${error.line}: ` : ": "}{error.text}.</>
        ) : (
          // Виновника нет (ошибка слитой схемы), но номер строки, если он в
          // тексте был, не теряем: без него сообщение адресует в пустоту.
          lineAndText(error)
        )}
      </div>
      {чип !== null && error.chipIndex !== null && (
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
    </>
  );
}
