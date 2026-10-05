// Модалка «Описать логику с помощью агента» (BYOA-дозаливка) — ТОЛЬКО СХЕМЫ
// ЛОГИКИ (node_docs, mermaid). OpenAPI-спека узла — отдельное окно спеки
// (DocOverlay → SpecAgentPanel): сущности не смешиваются (include промпта и фильтр
// превью/применения зафиксированы на «logic»). Скоуп — ТЕКУЩИЙ УЗЕЛ, два режима:
// «Пакетом» — все схемы объекта за заход (микросервисы); «По одной схеме» — один
// воркер/эндпоинт (крупные монолиты), слева поле «Что описать» (target — блок
// фокуса в промпте). Одну схему со страницы правят не здесь, а в её окне
// («Изменить → Через ИИ-агента»): туда же ведёт и неописанная строка.
// Здесь только оболочка и левая колонка (параметры промпта). Файлы пакета, превью
// и применение — DocsAgentPanel: то же тело живёт в окне одной схемы (DocOverlay).
// Закрытие после успешного применения — отсюда (onClose); родитель через onApplied
// только освежает мету узла.
import { useState } from "react";
import type { CSSProperties } from "react";
import type { PromptVariant } from "../../types";
import { docsImportApi, type DocsPromptParams } from "../../api/docsImport";
import { head, sub, cols, leftCol, radioRow, hintsArea } from "./agentModalShared";
import DocsAgentPanel from "./DocsAgentPanel";
import PromptCopyButton from "./PromptCopyButton";
import Modal from "../../ui/Modal";
import { CloseIcon } from "../../ui/icons";
import { labelStyle } from "../../ui/styles";
import { noAutofill } from "../../ui/noAutofill";

type Mode = "batch" | "single";

interface Props {
  // Узел, для которого агент готовит документы (скоуп промпта и применения).
  nodeId: string;
  nodeName: string;
  onClose: () => void;
  // Дозаливка применена — родитель освежает мету узла (docs/спека).
  onApplied: () => void;
}

export default function DocsAgentModal({ nodeId, nodeName, onClose, onApplied }: Props) {
  const [mode, setMode] = useState<Mode>("batch");
  // ── параметры промпта (include зафиксирован на схемах логики) ──
  const [lang, setLang] = useState<"ru" | "en">("ru");
  const [hints, setHints] = useState("");
  const [target, setTarget] = useState(""); // «По одной»: воркер/эндпоинт
  // Запрос промпта + запись в буфер В ПРЕДЕЛАХ ЖЕСТА (промежуточных await между
  // кликом и writeText не добавляем). «Скопировано» показывает PromptCopyButton по
  // разрешению этого обещания — своё у каждого из трёх вариантов.
  function copyPrompt(variant: PromptVariant): Promise<void> {
    // include зафиксирован на схемах логики (OpenAPI-спека — окно спеки);
    // в режиме «по одной» target фокусирует агента на одном воркере/эндпоинте
    // (пустой target в «пакетом» клиент не передаёт).
    const params: DocsPromptParams = { nodeId, include: "logic", lang, hints, target, variant };
    return docsImportApi.prompt(params).then(({ prompt }) => navigator.clipboard.writeText(prompt));
  }

  // Пакет применён: «Добавить ещё» оставляет окно под следующую точку входа
  // (адрес очищаем здесь, пакет панель очистила сама), остальное закрывает окно.
  function applied(more: boolean) {
    onApplied();
    if (more) setTarget("");
    else onClose();
  }

  return (
    <Modal onClose={onClose} closeButton={false} boxStyle={{ width: 1060, maxWidth: "calc(100vw - 48px)", maxHeight: "92vh", overflowY: "auto" }}>
      <div style={head}>
        <h2 style={{ margin: 0, fontSize: 17 }}>Описать логику с помощью агента</h2>
        <button onClick={onClose} className="modal-close" aria-label="Закрыть"><CloseIcon /></button>
      </div>
      <p style={sub}>
        ИИ-агент поможет дополнить документацию объекта «{nodeName}» логическими диаграммами
        в Mermaid. Скопируйте промпт, запустите своим агентом в репозитории сервиса и загрузите
        сюда полученные файлы пакета archmap-docs/.
      </p>

      {/* Переключатель режимов */}
      <div style={segWrap}>
        <div style={seg} role="tablist" aria-label="Режим дозаливки">
          <button type="button" role="tab" aria-selected={mode === "batch"} style={mode === "batch" ? segBtnOn : segBtn} onClick={() => setMode("batch")}>
            Пакетом
          </button>
          <button type="button" role="tab" aria-selected={mode === "single"} style={mode === "single" ? segBtnOn : segBtn} onClick={() => setMode("single")}>
            По одной схеме
          </button>
        </div>
        <span style={segNote}>
          {mode === "batch"
            ? "Агент отдаст пакет со всеми схемами объекта за один заход. Используйте этот режим в репозиториях микросервисов"
            : "Агент отдаст схему одного воркера или эндпоинта за один заход. Используйте этот режим в репозиториях крупных монолитов"}
        </span>
      </div>

      <div style={cols}>
        {/* ── Слева: параметры промпта ── */}
        <div style={leftCol}>
          {mode === "single" && (
            <>
              <label style={labelStyle}>Что описать</label>
              <textarea
                {...noAutofill("docs-agent-modal-1")}
                style={targetInput}
                rows={3}
                value={target}
                onChange={(e) => setTarget(e.target.value)}
                placeholder="воркер или эндпоинт: OrderCreatedHandler, POST /orders"
              />
            </>
          )}

          <label style={labelStyle}>Язык подписей</label>
          <div style={{ display: "flex", gap: 14, marginBottom: 10 }}>
            <label style={radioRow}>
              <input type="radio" checked={lang === "ru"} onChange={() => setLang("ru")} /> Русский
            </label>
            <label style={radioRow}>
              <input type="radio" checked={lang === "en"} onChange={() => setLang("en")} /> English
            </label>
          </div>

          <label style={labelStyle}>Подсказки агенту (опционально)</label>
          <textarea
            {...noAutofill("docs-agent-modal-2")}
            style={hintsArea}
            value={hints}
            onChange={(e) => setHints(e.target.value)}
            placeholder={"Например: документируй только сервис billing;\nкаждый воркер опиши отдельной схемой."}
          />

          <PromptCopyButton
            label="Скопировать промпт"
            copiedLabel="Скопировано ✓"
            kind="primary"
            buttonStyle={{ marginTop: 4 }}
            copy={copyPrompt}
          />
        </div>

        {/* ── Справа: файлы пакета + превью + применение ── */}
        <DocsAgentPanel nodeId={nodeId} mode={{ kind: mode }} onApplied={applied} />
      </div>
    </Modal>
  );
}

// ── inline-стили переключателя режимов и поля адреса (остальные — agentModalShared) ──

const segWrap: CSSProperties = { display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap", margin: "0 0 14px" };
const seg: CSSProperties = {
  display: "inline-flex", gap: 3, padding: 3, background: "#f1f5f9",
  border: "1px solid #e2e8f0", borderRadius: 10,
};
const segBtnBase: CSSProperties = {
  border: "none", borderRadius: 8, padding: "6px 14px", font: "inherit",
  fontSize: 13, cursor: "pointer", transition: "background .12s, color .12s",
};
const segBtn: CSSProperties = { ...segBtnBase, background: "transparent", color: "#64748b", fontWeight: 500 };
const segBtnOn: CSSProperties = {
  ...segBtnBase, background: "#fff", color: "#1e293b", fontWeight: 600,
  boxShadow: "0 1px 3px rgba(15,23,42,.14)",
};
const segNote: CSSProperties = { fontSize: 12, color: "#94a3b8", lineHeight: 1.4 };
const targetInput: CSSProperties = {
  width: "100%", boxSizing: "border-box", marginBottom: 10, padding: "8px 10px",
  border: "1px solid #e2e8f0", borderRadius: 8, fontSize: 13, color: "#0f172a",
  fontFamily: "inherit", resize: "vertical", lineHeight: 1.45,
};
