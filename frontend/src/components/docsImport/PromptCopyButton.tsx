// Кнопка BYOA-промпта — общая для ВСЕХ окон, где ArchMap выдаёт задание агенту:
// окна дозаливки на странице объекта (схемы логики, структура БД, каналы, конфигурация,
// список операций), стадия «Через ИИ-агента» окна схемы и окна спецификации, создание
// проекта «ИИ-агент» и «Обновить из кода».
//
// Кнопка отдаёт ОРКЕСТРАТОРНЫЙ промпт: агент пользователя сам запускает субагентов
// строителя и скептика и выдаёт пакет, уже проверенный по коду
// (docs/plan-skeptic-audit.md). Прежние подпись-гейт «понадобятся субагенты» и
// запасные ссылки «Промпт без аудита» / «Только промпт аудита» сняты решением
// пользователя 2026-09-28 во всех окнах: подробности аудита в окне только мешают,
// а без субагентов промпт останавливается сам и говорит об этом. Варианты
// builder/skeptic живут в API (MCP) — кнопка их больше не предлагает.
//
// Компонент объявлен НА ВЕРХНЕМ УРОВНЕ модуля (инлайновый компонент ремаунтится
// каждый рендер — ловушка проекта, см. memory «inline components break DnD»).
//
// Вид — новый язык (редизайн): кнопка ds-btn по своей ширине, текст для ручного
// копирования на токенах (agentParts.css). Прежний вид на инлайн-стилях снят вместе с
// последним окном прежнего вида (стадия агента окна документа, фаза 7в).
import { useEffect, useRef, useState } from "react";
import type { PromptVariant } from "../../types";
import { CopyFailed } from "../../lib/copyText";
import "../../ui/ds.css";
import "./agentParts.css";

// Сколько держится «скопировано».
const COPIED_MS = 2000;

interface Props {
  /** Подпись кнопки в покое — своя у каждого окна, её не меняем. */
  label: string;
  /** Её же подпись сразу после копирования (тоже своя у окна). */
  copiedLabel: string;
  /** Вид кнопки: secondary во всех окнах агента; primary — если задание главное действие окна. */
  kind: "primary" | "secondary";
  /**
   * Скопировать промпт варианта. Окно САМО делает запрос и пишет в буфер через
   * lib/copyText — так запись начинается в пределах жеста; промежуточных await между
   * кликом и записью не добавляем. Обещание разрешилось — «скопировано»; CopyFailed
   * (буфер недоступен: http, отказ браузера) — показываем текст для ручного
   * копирования (аудит R-6); прочий отказ (запрос промпта) показывает окно.
   */
  copy: (variant: PromptVariant) => Promise<void>;
  disabled?: boolean;
}

export default function PromptCopyButton({ label, copiedLabel, kind, copy, disabled }: Props) {
  const [copied, setCopied] = useState(false);
  // Текст, который не удалось положить в буфер: показываем его для ручного копирования.
  const [manual, setManual] = useState<string | null>(null);
  const timer = useRef(0);
  useEffect(() => () => window.clearTimeout(timer.current), []);

  function click() {
    void copy("orchestrated").then(
      () => {
        setManual(null);
        window.clearTimeout(timer.current); // повторный клик продлевает «скопировано»
        setCopied(true);
        timer.current = window.setTimeout(() => setCopied(false), COPIED_MS);
      },
      (e: unknown) => {
        if (e instanceof CopyFailed) setManual(e.text);
      },
    );
  }

  return (
    <div className="pcb">
      <button
        type="button"
        className={`ds-btn${kind === "primary" ? " ds-btn--primary" : ""}`}
        disabled={disabled}
        onClick={click}
      >
        {copied ? copiedLabel : label}
      </button>
      {manual !== null && (
        <>
          <p className="pcb-hint" role="status">
            Браузер не дал скопировать автоматически. Выделите текст ниже и скопируйте
            (Ctrl+C).
          </p>
          <textarea
            readOnly
            value={manual}
            className="pcb-area"
            aria-label="Текст задания"
            onFocus={(e) => e.currentTarget.select()}
            ref={(el) => el?.select()}
          />
        </>
      )}
    </div>
  );
}
