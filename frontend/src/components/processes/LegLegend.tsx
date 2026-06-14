// Легенда плеч (футер viewer/editor). Портировано из дизайн-референса (bp-parts.jsx).
import type { MessageKind } from "../../types";
import { legMeta } from "./legMeta";
import { BPT } from "./tokens";

export default function LegLegend() {
  const row = (kind: MessageKind) => {
    const m = legMeta(kind);
    return (
      <span style={{ display: "inline-flex", alignItems: "center", gap: 5, color: BPT.sec, fontSize: 11.5 }}>
        <span style={{ color: m.ink, display: "inline-flex" }}>
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
      <span style={{ display: "inline-flex", alignItems: "center", gap: 5, color: BPT.sec, fontSize: 11.5 }}>
        <span
          style={{
            fontSize: 10,
            fontWeight: 800,
            color: BPT.amber,
            background: BPT.amberBg,
            border: "1px solid " + BPT.amberLine,
            borderRadius: 4,
            padding: "0 5px",
          }}
        >
          alt
        </span>
        ветвление
      </span>
    </>
  );
}
