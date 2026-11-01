// Окно первого вложенного объекта при переносе (Р38 раздела 13 docs/plan-c4-elements.md):
// сервис без хранимого элемента переносят в лист без хранимого элемента, и окно
// спрашивает со стороны переносимого — что такое «Y» внутри «X». Ответ задаёт элемент
// цели: «Компонент» — «X» станет контейнером, «Отдельное приложение» — системой.
// Показывается ДО переноса — вложенных нативных окон не бывает (ui/Modal).
import { useState } from "react";
import type { CSSProperties } from "react";
import type { NodeElement } from "../../types";
import Modal from "../../ui/Modal";
import DialogTitle from "../../ui/DialogTitle";
import { primaryBtn, secondaryBtn } from "../../ui/styles";

interface Props {
  // Цель переноса (лист, который получает первый вложенный объект).
  parentName: string;
  // Переносимый объект.
  childName: string;
  preselect: NodeElement;
  busy: boolean;
  onConfirm: (element: NodeElement) => void;
  onCancel: () => void;
}

// Вариант — элемент, который получит цель: сначала «Компонент» (цель — контейнер).
const OPTIONS: NodeElement[] = ["container", "system"];

const OPTION_LABEL: Record<NodeElement, string> = {
  container: "Компонент",
  system: "Отдельное приложение",
};

function optionText(element: NodeElement, parent: string): string {
  return element === "container"
    ? `Часть кода «${parent}», отдельно не запускается. «${parent}» станет контейнером, `
      + "документация и площадки останутся у него."
    : `Запускается само по себе. «${parent}» станет системой, документация и площадки `
      + "ведутся у вложенных объектов.";
}

export default function FirstChildDialog({ parentName, childName, preselect, busy, onConfirm, onCancel }: Props) {
  const [choice, setChoice] = useState<NodeElement>(preselect);
  return (
    <Modal onClose={onCancel} onSubmit={() => onConfirm(choice)} closeButton={false} boxStyle={{ width: 500 }}>
      <DialogTitle lead={`От этого зависит, кем станет «${parentName}» и как ArchMap поведёт его документацию и площадки.`}>
        Что такое «{childName}» внутри «{parentName}»?
      </DialogTitle>
      <div role="radiogroup" aria-label={`Что такое «${childName}»`} style={{ display: "flex", flexDirection: "column", gap: 8 }}>
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
                <span style={optionTitle}>{OPTION_LABEL[element]}</span>
                <span style={optionBody}>{optionText(element, parentName)}</span>
              </span>
            </label>
          );
        })}
      </div>
      <p style={hint}>Ответ можно изменить в свойствах «{parentName}».</p>
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
