// Окно «Внутри «X» появился первый объект» (Р4, тексты прототипа v2 дословно): выбор
// элемента архитектуры листа, который получает первого ребёнка. Показывается ДО окна
// «Новый объект» и до переноса — вложенных нативных окон не бывает (ui/Modal).
import { useState } from "react";
import type { CSSProperties } from "react";
import type { NodeElement } from "../../types";
import Modal from "../../ui/Modal";
import DialogTitle from "../../ui/DialogTitle";
import { primaryBtn, secondaryBtn } from "../../ui/styles";
import { ELEMENT_LABEL } from "../nodeTerms";

interface Props {
  parentName: string;
  preselect: NodeElement;
  busy: boolean;
  onConfirm: (element: NodeElement) => void;
  onCancel: () => void;
}

// Порядок вариантов — как в прототипе: сначала «Контейнер».
const OPTIONS: NodeElement[] = ["container", "system"];

function optionText(element: NodeElement, name: string): string {
  return element === "container"
    ? "Одно приложение, которое запускается целиком. Объекты внутри описывают, из чего оно "
      + `состоит, и отдельно не запускаются. Документация и площадки остаются у «${name}».`
    : "Несколько приложений, каждое запускается само по себе. Документация и площадки "
      + "ведутся у каждого из них.";
}

export default function FirstChildDialog({ parentName, preselect, busy, onConfirm, onCancel }: Props) {
  const [choice, setChoice] = useState<NodeElement>(preselect);
  return (
    <Modal onClose={onCancel} onSubmit={() => onConfirm(choice)} closeButton={false} boxStyle={{ width: 500 }}>
      <DialogTitle lead={`Уточните, что такое «${parentName}». От этого зависит, как ArchMap будет вести его документацию и площадки.`}>
        Внутри «{parentName}» появился первый объект
      </DialogTitle>
      <div role="radiogroup" aria-label="Элемент архитектуры" style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        {OPTIONS.map((element) => {
          const active = element === choice;
          return (
            <label key={element} style={active ? optionActive : option}>
              <input
                type="radio"
                name="first-child-element"
                checked={active}
                onChange={() => setChoice(element)}
                style={{ margin: "3px 0 0", flexShrink: 0 }}
              />
              <span>
                <span style={optionTitle}>{ELEMENT_LABEL[element]}</span>
                <span style={optionBody}>{optionText(element, parentName)}</span>
              </span>
            </label>
          );
        })}
      </div>
      <p style={hint}>Ответ можно изменить в любой момент в свойствах «{parentName}».</p>
      <div style={{ display: "flex", gap: 8, marginTop: 16 }}>
        <button type="button" onClick={() => onConfirm(choice)} disabled={busy} style={primaryBtn}>
          Продолжить
        </button>
        <button type="button" onClick={onCancel} disabled={busy} style={secondaryBtn}>
          Отмена
        </button>
      </div>
    </Modal>
  );
}

const option: CSSProperties = {
  display: "flex", gap: 10, alignItems: "flex-start", padding: "10px 12px",
  border: "1px solid #e2e8f0", borderRadius: 10, cursor: "pointer", background: "#fff",
};
const optionActive: CSSProperties = { ...option, border: "1px solid #2563eb", background: "#eff6ff" };
const optionTitle: CSSProperties = { display: "block", fontSize: 14, fontWeight: 600, color: "#0f172a", marginBottom: 2 };
const optionBody: CSSProperties = { display: "block", fontSize: 13, color: "#475569", lineHeight: 1.45 };
const hint: CSSProperties = { margin: "12px 0 0", fontSize: 12.5, color: "#64748b" };
