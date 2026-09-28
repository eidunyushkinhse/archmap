// Кнопка BYOA-промпта — общая для ВСЕХ окон, где ArchMap выдаёт промпт агенту:
// шесть окон дозаливки на странице объекта (логика, спека, структура БД, каналы,
// конфигурация, разведка), создание проекта «ИИ-агент» и «Обновить из репозитория».
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
import { useEffect, useRef, useState } from "react";
import type { CSSProperties } from "react";
import type { PromptVariant } from "../../types";
import { primaryBtn, secondaryBtn } from "../../ui/styles";

// Сколько держится «скопировано».
const COPIED_MS = 2000;

interface Props {
  /** Подпись главной кнопки в покое — своя у каждого окна, её не меняем. */
  label: string;
  /** Её же подпись сразу после копирования (тоже своя у окна). */
  copiedLabel: string;
  /** Вид главной кнопки: primary в окнах дозаливки, secondary в импорте и синке. */
  kind: "primary" | "secondary";
  /** Доводка стиля главной кнопки по месту: отступ, приглушение неактивной. */
  buttonStyle?: CSSProperties;
  /**
   * Скопировать промпт варианта. Окно САМО делает запрос и пишет в буфер — так
   * writeText остаётся в пределах жеста (Chrome иначе отбирает разрешение);
   * промежуточных await между кликом и записью не добавляем. Обещание разрешилось
   * — показываем «скопировано», отклонилось — молчим (ошибку показывает окно).
   */
  copy: (variant: PromptVariant) => Promise<void>;
  disabled?: boolean;
}

export default function PromptCopyButton({ label, copiedLabel, kind, buttonStyle, copy, disabled }: Props) {
  const [copied, setCopied] = useState(false);
  const timer = useRef(0);
  useEffect(() => () => window.clearTimeout(timer.current), []);

  function click() {
    void copy("orchestrated").then(
      () => {
        window.clearTimeout(timer.current); // повторный клик продлевает «скопировано»
        setCopied(true);
        timer.current = window.setTimeout(() => setCopied(false), COPIED_MS);
      },
      () => undefined,
    );
  }

  return (
    <div style={wrap}>
      <button
        type="button"
        style={{ ...(kind === "primary" ? primaryBtn : secondaryBtn), ...buttonStyle }}
        disabled={disabled}
        onClick={click}
      >
        {copied ? copiedLabel : label}
      </button>
    </div>
  );
}

// Колонка, а не просто div: кнопка внутри растягивается по ширине боковой колонки.
const wrap: CSSProperties = { display: "flex", flexDirection: "column" };
