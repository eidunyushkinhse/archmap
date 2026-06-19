// Легенда типов плеч (футер viewer/editor). Тип сообщения теперь монохром — кодируется
// формой (линия + наконечник), а не цветом (цвет = статус узла). Плюс строка повисшего
// сообщения (янтарь, «разорванная цепь»).
import type { MessageKind } from "../../types";
import { IcoBrokenLink } from "./icons";
import { legMeta } from "./legMeta";
import { BPT, BROKEN } from "./tokens";

export default function LegLegend() {
  const row = (kind: MessageKind) => {
    const m = legMeta(kind);
    return (
      <span style={{ display: "inline-flex", alignItems: "center", gap: 5, color: BPT.sec, fontSize: 11.5 }}>
        <span style={{ color: BPT.head, display: "inline-flex" }}>
          <m.Icon s={13} />
        </span>
        {m.word}
      </span>
    );
  };
  return (
    <>
      {row("forward")}
      {row("return")}
      {row("async")}
      <span style={{ display: "inline-flex", alignItems: "center", gap: 5, color: BROKEN.ink, fontSize: 11.5 }}>
        <span style={{ display: "inline-flex" }}>
          <IcoBrokenLink s={13} />
        </span>
        связь удалена
      </span>
    </>
  );
}
