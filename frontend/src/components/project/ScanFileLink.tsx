import type { CSSProperties } from "react";
import { scanApi } from "../../api/scan";
import { useAsyncLoad } from "../../lib/useAsyncLoad";

interface Props {
  /** Отступ под место в окне: в окне «Новый проект» абзац стоит в колонке с gap, в окне
   *  «Обновить из кода» под пояснением к кнопке промпта. */
  style?: CSSProperties;
}

/**
 * Ссылка на файл сборщика фактов для пути без агента (фаза 3 docs/tasks/fact-collector.md):
 * человек скачивает archmap-scan.pyz, запускает его в репозитории и добавляет schema.yaml в
 * это окно, а файлы facts/ окнами фактов на страницах объектов. Версию называет сервер
 * (GET /scan). Файла в поставке нет (404) или запрос не удался — абзаца нет вовсе: ссылка в
 * никуда хуже отсутствующей, а окну без неё ничего не мешает.
 */
export default function ScanFileLink({ style }: Props) {
  const info = useAsyncLoad("scan-file", scanApi.info);
  if (!info.data) return null;
  return (
    <p style={{ ...note, ...style }}>
      Схему и факты можно собрать из репозитория без агента: скачайте{" "}
      <a href={scanApi.fileUrl} download>сборщик фактов</a> (версия {info.data.version}) и
      запустите его в репозитории командой <code>python3 archmap-scan.pyz</code>. Файл
      schema.yaml добавьте сюда, а файлы из папки facts на страницах баз данных, контейнеров и
      брокеров.
    </p>
  );
}

const note: CSSProperties = { margin: 0, fontSize: 12.5, lineHeight: 1.55, color: "#64748b" };
