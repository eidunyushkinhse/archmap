// ER-диаграмма во весь экран с пан/зумом.
//
// Повод: встроенная в секцию диаграмма на реальной базе (пять таблиц, тридцать пять
// колонок) нечитаема — она масштабируется под ширину карточки. Полноэкранный режим
// повторяет превью схем логики: та же сцена, тот же хук пан/зума и та же пилюля
// контролов (классы doc-pv*/doc-zoom из docOverlay.css) — окно должно выглядеть как
// уже знакомое, а не как второй способ смотреть диаграммы.
import { useCallback, useRef, useState } from "react";
import MermaidRenderer from "./MermaidRenderer";
import type { MmdStatus } from "./MermaidRenderer";
import { pinSvgSize, usePanZoom } from "./usePanZoom";
import Modal from "../ui/Modal";
import { CloseIcon } from "../ui/icons";
import "./inspector/docOverlay.css";

interface Props {
  chart: string;
  title: string;
  onClose: () => void;
}

export default function ErDiagramModal({ chart, title, onClose }: Props) {
  const stageRef = useRef<HTMLDivElement>(null);
  const pzRef = useRef<HTMLDivElement>(null);
  const pz = usePanZoom(stageRef, pzRef);
  const { fitInitial } = pz;
  const fittedRef = useRef(false);
  const [error, setError] = useState<string | null>(null);

  const handleStatus = useCallback(
    (s: MmdStatus) => {
      setError(s.kind === "error" ? s.message : null);
      if (s.kind !== "ok") return;
      pinSvgSize(pzRef.current);
      // Вписываем ОДИН раз: дальше пан/зум пользователя не сбрасываем.
      if (!fittedRef.current) {
        fittedRef.current = true;
        fitInitial();
      }
    },
    [fitInitial],
  );

  return (
    <Modal
      onClose={onClose}
      closeButton={false}
      // Высоту задаём СВОЕМУ содержимому, а не боксу. Modal кладёт контент во
      // внутреннюю обёртку без высоты (ей достаются только padding/display/
      // flexDirection), поэтому `flex: 1` у сцены схлопывался в ноль — окно
      // открывалось пустым. Диалог теперь тянется за содержимым.
      boxStyle={{ width: "calc(100vw - 48px)", maxWidth: "none", padding: 20 }}
    >
      {/* 88px = поля вьюпорта (48) + собственные отступы обёртки (20 сверху и снизу) */}
      <div style={{ display: "flex", flexDirection: "column", height: "calc(100vh - 88px)" }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 8 }}>
          <h2 style={{ margin: 0, fontSize: 16 }}>{title}</h2>
          <button onClick={onClose} className="modal-close" aria-label="Закрыть"><CloseIcon /></button>
        </div>
        <div className="doc-pv" style={{ flex: 1, minHeight: 0 }}>
        <div
          ref={stageRef}
          className={"doc-pvstage" + (pz.dragging ? " doc-pvstage--drag" : "")}
          {...pz.handlers}
        >
          <div ref={pzRef} className="doc-pz" style={pz.style}>
            <MermaidRenderer chart={chart} onStatus={handleStatus} />
          </div>
          {error !== null && (
            <div className="doc-pvcenter">
              <div className="doc-mmderr">В диаграмме ошибка синтаксиса: {error}</div>
            </div>
          )}
          <div className="doc-zoom">
            <button type="button" onClick={pz.zoomOut} aria-label="Уменьшить">−</button>
            <span className="doc-zval">{Math.round(pz.scale * 100)}%</span>
            <button type="button" onClick={pz.zoomIn} aria-label="Увеличить">+</button>
            <span className="doc-zsep" />
            <button type="button" onClick={pz.fit} title="Вписать" aria-label="Вписать">
              <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5">
                <rect x="2.5" y="2.5" width="11" height="11" rx="1.5" />
              </svg>
            </button>
          </div>
        </div>
      </div>
      </div>
    </Modal>
  );
}
