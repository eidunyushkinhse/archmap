// Модалка «Спека от агента» (BYOA-дозаливка) — ТОЛЬКО OpenAPI-спека узла
// (openapi_spec, одна на узел). Схемы логики — отдельное окно DocsAgentModal:
// сущности не смешиваются (include промпта и фильтр превью/применения
// зафиксированы на «api»). Слева параметры промпта (язык/подсказки →
// «Скопировать промпт»; агент найдёт готовую спеку в репозитории, сгенерирует
// из фреймворка или синтезирует по коду), справа файлы пакета archmap-docs
// (manifest.yaml со ссылкой на файл спеки + сам файл), живой dry-run с политикой
// перезаписи и «Применить». Спека одна — без режимов «пакетом/по одной» и
// «Добавить ещё». Правая колонка — SpecAgentPanel (то же тело живёт в окне спеки
// DocOverlay). Закрытие после успешного применения — отсюда (onClose); родитель
// через onApplied только освежает мету узла.
import { useState } from "react";
import type { PromptVariant } from "../../types";
import { docsImportApi } from "../../api/docsImport";
import { head, sub, cols, leftCol, radioRow, hintsArea } from "./agentModalShared";
import SpecAgentPanel from "./SpecAgentPanel";
import PromptCopyButton from "./PromptCopyButton";
import Modal from "../../ui/Modal";
import { CloseIcon } from "../../ui/icons";
import { labelStyle } from "../../ui/styles";

interface Props {
  // Узел, для которого агент готовит спеку (скоуп промпта и применения).
  nodeId: string;
  nodeName: string;
  onClose: () => void;
  // Дозаливка применена — родитель освежает мету узла (спека + version).
  onApplied: () => void;
}

export default function SpecAgentModal({ nodeId, nodeName, onClose, onApplied }: Props) {
  // ── параметры промпта (include зафиксирован на API-спеке) ──
  const [lang, setLang] = useState<"ru" | "en">("ru");
  const [hints, setHints] = useState("");
  // Запрос промпта + запись в буфер В ПРЕДЕЛАХ ЖЕСТА; «скопировано» по каждому из
  // трёх вариантов показывает PromptCopyButton по разрешению этого обещания.
  function copyPrompt(variant: PromptVariant): Promise<void> {
    return docsImportApi
      .prompt({ nodeId, include: "api", lang, hints, variant })
      .then(({ prompt }) => navigator.clipboard.writeText(prompt));
  }

  return (
    <Modal onClose={onClose} closeButton={false} boxStyle={{ width: 1060, maxWidth: "calc(100vw - 48px)", maxHeight: "92vh", overflowY: "auto" }}>
      <div style={head}>
        <h2 style={{ margin: 0, fontSize: 17 }}>Подготовить OpenAPI-спецификацию с помощью ИИ-агента</h2>
        <button onClick={onClose} className="modal-close" aria-label="Закрыть"><CloseIcon /></button>
      </div>
      <p style={sub}>
        ИИ-агент поможет дополнить документацию объекта «{nodeName}» спецификацией OpenAPI.
        Скопируйте промпт, запустите своим агентом в репозитории сервиса и загрузите сюда
        полученные файлы пакета archmap-docs/.
      </p>

      <div style={cols}>
        {/* ── Слева: параметры промпта ── */}
        <div style={leftCol}>
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
            style={hintsArea}
            value={hints}
            onChange={(e) => setHints(e.target.value)}
            placeholder={"Например: спеку возьми из swagger.yaml;\nесли её нет — синтезируй по хендлерам."}
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
        <SpecAgentPanel nodeId={nodeId} onApplied={() => { onApplied(); onClose(); }} />
      </div>
    </Modal>
  );
}
