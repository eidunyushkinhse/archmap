// Тройка кнопок BYOA-промпта — общая для ШЕСТИ окон (логика, спека, структура БД,
// каналы, «Из репозитория» при создании проекта и «Обновить из репозитория»).
//
// Главная кнопка каждого окна сохраняет своё место, вид и подпись, но отдаёт теперь
// ОРКЕСТРАТОРНЫЙ промпт: агент пользователя сам запускает субагентов строителя и
// скептика и выдаёт пакет, уже проверенный по коду (docs/plan-skeptic-audit.md —
// аудит обязателен по умолчанию, потому что валидатор ArchMap сторожит
// согласованность, а слабая модель производит согласованную ложь). Запасные пути —
// двумя мелкими ссылками под подписью-гейтом: «без аудита» для агента без
// субагентов и «только аудит», чтобы догнать уже собранный пакет.
//
// Компонент объявлен НА ВЕРХНЕМ УРОВНЕ модуля (инлайновый компонент ремаунтится
// каждый рендер — ловушка проекта, см. memory «inline components break DnD»), а
// сам файл экспортирует только компонент (react-refresh/only-export-components).
import { useEffect, useRef, useState } from "react";
import type { CSSProperties } from "react";
import type { PromptVariant } from "../../types";
import { primaryBtn, secondaryBtn } from "../../ui/styles";

// Подпись-гейт: ДОСЛОВНО одна на все шесть окон. Говорит две вещи, которые иначе
// выяснятся только после запуска: пакет проверяется вторым агентом и агенту
// понадобятся субагенты (без них оркестраторный промпт остановится сам).
const GATE_NOTE =
  "Промпт включает аудит вторым агентом-скептиком: перед выдачей пакет проверяется " +
  "по коду. Вашему агенту понадобятся субагенты.";

const PLAIN_LABEL = "Промпт без аудита";
const SKEPTIC_LABEL = "Только промпт аудита";
const LINK_COPIED = "Скопировано ✓";
// Сколько держится «скопировано» (у всех трёх вариантов одинаково).
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

export default function PromptTriple({ label, copiedLabel, kind, buttonStyle, copy, disabled }: Props) {
  // Какой из трёх промптов только что скопирован. Состояние ОДНО на тройку: двух
  // «скопировано» разом быть не должно — иначе непонятно, что лежит в буфере.
  const [copied, setCopied] = useState<PromptVariant | null>(null);
  const timer = useRef(0);
  useEffect(() => () => window.clearTimeout(timer.current), []);

  function click(variant: PromptVariant) {
    void copy(variant).then(
      () => {
        window.clearTimeout(timer.current); // предыдущее «скопировано» гасим сразу
        setCopied(variant);
        timer.current = window.setTimeout(() => setCopied(null), COPIED_MS);
      },
      () => undefined,
    );
  }

  const link: CSSProperties = disabled ? { ...linkBase, color: "#94a3b8" } : linkBase;

  return (
    <div style={wrap}>
      <button
        type="button"
        style={{ ...(kind === "primary" ? primaryBtn : secondaryBtn), ...buttonStyle }}
        disabled={disabled}
        onClick={() => click("orchestrated")}
      >
        {copied === "orchestrated" ? copiedLabel : label}
      </button>
      <p style={gateNote}>{GATE_NOTE}</p>
      <div style={linksRow}>
        <button type="button" style={link} disabled={disabled} onClick={() => click("builder")}>
          {copied === "builder" ? LINK_COPIED : PLAIN_LABEL}
        </button>
        <span aria-hidden="true" style={{ color: "#cbd5e1", fontSize: 11.5 }}>·</span>
        <button type="button" style={link} disabled={disabled} onClick={() => click("skeptic")}>
          {copied === "skeptic" ? LINK_COPIED : SKEPTIC_LABEL}
        </button>
      </div>
    </div>
  );
}

// Колонка, а не просто div: главная кнопка внутри должна растягиваться по ширине
// боковой колонки ровно так же, как растягивалась до появления тройки.
const wrap: CSSProperties = { display: "flex", flexDirection: "column" };
// Кегль и цвет — как у прочих подсказок окон (leftNote в agentModalShared).
const gateNote: CSSProperties = { margin: "8px 0 0", fontSize: 11.5, color: "#94a3b8", lineHeight: 1.5 };
const linksRow: CSSProperties = { display: "flex", alignItems: "baseline", flexWrap: "wrap", gap: 6, marginTop: 6 };
const linkBase: CSSProperties = {
  border: "none", background: "none", padding: 0, font: "inherit", fontSize: 11.5,
  fontWeight: 600, color: "#2563eb", textAlign: "left",
};
