import { useCallback, useState } from "react";
import type { CSSProperties } from "react";
import { nodesApi } from "../api/nodes";
import Modal from "../ui/Modal";
import { dangerBtn, secondaryBtn } from "../ui/styles";

/**
 * Подтверждение команды «Переразложить уровень» (own-on-first-render, Ф2).
 *
 * Стирает ВСЕ строки вида текущего уровня: позиции локальных узлов и гостей и
 * раскрытия контейнеров — уровень возвращается к авто-виду (ELK + кольца +
 * авто-маршруты), как при первом открытии. Действие необратимо (отдельного
 * Undo нет; вся история чистится), поэтому подтверждаем модалкой.
 */

interface Props {
  // Уровень, который переразложить: containerId узла или null для корня.
  containerId: string | null;
  // Человекочитаемое имя уровня (для заголовка); пусто/undefined — корень схемы.
  levelName?: string;
  onCancel: () => void;
  // Сброс выполнен на бэкенде — родитель перезагружает уровень и чистит историю.
  onDone: () => void;
}

export default function RelayoutConfirm({ containerId, levelName, onCancel, onDone }: Props) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const confirm = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      await nodesApi.relayoutLevel(containerId);
      onDone();
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : "Не удалось переразложить уровень");
      setBusy(false);
    }
  }, [containerId, onDone]);

  const where = levelName ? `«${levelName}»` : "корневой схемы";

  return (
    <Modal onClose={onCancel} closeButton={false} boxStyle={{ width: 460, padding: 24 }}>
      <div style={titleRow}>
        <span style={warnPlaque} aria-hidden>{WARN_ICON}</span>
        <h3 style={title}>Переразложить уровень {where}?</h3>
      </div>
      <p style={lead}>
        Все ручные правки расположения на этом уровне будут сброшены к
        авто-раскладке: позиции узлов, точки стыковки и изломы стрелок.
        Раскрытые контейнеры свернутся — при повторном раскрытии их дети
        разложатся заново. Действие нельзя отменить.
      </p>
      {error && <p style={errText}>{error}</p>}
      <div style={{ display: "flex", gap: 8, marginTop: 16 }}>
        <button onClick={confirm} disabled={busy} style={dangerBtn}>
          {busy ? "Сброс..." : "Да, переразложить"}
        </button>
        <button onClick={onCancel} disabled={busy} style={secondaryBtn}>
          Отмена
        </button>
      </div>
    </Modal>
  );
}

// Знак-предупреждение (линейный SVG, цвет от плашки через currentColor).
const WARN_ICON = (
  <svg width={20} height={20} viewBox="0 0 24 24" fill="none" stroke="currentColor"
       strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
    <path d="M12 4 L21.5 20 H2.5 Z" />
    <path d="M12 10 V14.5" />
    <circle cx="12" cy="17.5" r="0.6" fill="currentColor" stroke="none" />
  </svg>
);

const titleRow: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 12,
  marginBottom: 14,
};
const warnPlaque: CSSProperties = {
  flexShrink: 0,
  width: 36,
  height: 36,
  borderRadius: 10,
  background: "#fee2e2",
  color: "#dc2626",
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
};
const title: CSSProperties = {
  margin: 0,
  fontSize: 17,
  fontWeight: 700,
  color: "#1e293b",
  lineHeight: 1.3,
};
const lead: CSSProperties = {
  color: "#475569",
  margin: 0,
  fontSize: 14,
  lineHeight: 1.5,
};
const errText: CSSProperties = {
  color: "#dc2626",
  margin: "8px 0 0",
  fontSize: 13,
};
