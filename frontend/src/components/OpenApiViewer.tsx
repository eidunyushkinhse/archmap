// Рендер уже распарсенной OpenAPI-спеки через Swagger UI. Сборка тяжёлая, поэтому
// es-bundle и css грузятся лениво при первом открытии OpenAPI-оверлея (vite кладёт
// их в отдельные чанки — self-hosted, никаких CDN). try-it-out выключен: ArchMap —
// карта архитектуры, не API-клиент, кнопок Execute/Authorize быть не должно.
import { useEffect, useRef, useState } from "react";
import type { SwaggerUIBundle } from "swagger-ui-dist";

// Модульный синглтон загрузки. При отказе (битый деплой) сбрасывается,
// чтобы следующее открытие оверлея попробовало снова.
let swaggerP: Promise<SwaggerUIBundle> | null = null;
let swaggerReady = false;
function loadSwagger(): Promise<SwaggerUIBundle> {
  swaggerP ??= Promise.all([
    import("swagger-ui-dist/swagger-ui-es-bundle.js"),
    import("swagger-ui-dist/swagger-ui.css"),
  ]).then(
    ([mod]) => {
      swaggerReady = true;
      return mod.default;
    },
    (err: unknown) => {
      swaggerP = null;
      throw err;
    },
  );
  return swaggerP;
}

interface Props {
  spec: object; // уже распарсенный объект спеки (не сырой текст)
}

export default function OpenApiViewer({ spec }: Props) {
  const ref = useRef<HTMLDivElement>(null);
  const [state, setState] = useState<"loading" | "ready" | "failed">(
    swaggerReady ? "ready" : "loading",
  );

  useEffect(() => {
    let alive = true;
    const node = ref.current;
    loadSwagger()
      .then((SwaggerUI) => {
        if (!alive || !node) return;
        node.innerHTML = "";
        SwaggerUI({
          domNode: node,
          spec,
          presets: [SwaggerUI.presets.apis],
          layout: "BaseLayout",
          docExpansion: "list",
          defaultModelsExpandDepth: -1,
          supportedSubmitMethods: [],
        });
        setState("ready");
      })
      .catch(() => {
        if (alive) setState("failed");
      });
    return () => {
      alive = false;
      // Инстанс swagger-ui глобалей не держит — очистки контейнера достаточно
      if (node) node.innerHTML = "";
    };
  }, [spec]);

  if (state === "failed") return <div className="doc-pvnote">Не удалось загрузить рендерер</div>;
  return (
    <>
      {state === "loading" && <div className="doc-pvnote">Загрузка рендерера…</div>}
      <div ref={ref} className="doc-oas" />
    </>
  );
}
