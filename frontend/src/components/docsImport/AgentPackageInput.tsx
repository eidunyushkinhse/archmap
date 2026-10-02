// Приём пакета от агента в окнах дозаливки: чипы файлов, «Загрузить файлы…»,
// «+ вставить из буфера» и зона приёма (пустая) или поле активного файла. Общая
// часть панелей схем логики и спеки (DocsAgentPanel / SpecAgentPanel): разметка у
// них совпадала строка в строку, различались только подписи.
//
// Реф скрытого input[type=file] живёт здесь, а не в useDocsFiles: react-hooks/refs
// запрещает раздавать рефы из объекта, который возвращает хук.
import { useRef } from "react";
import type { DocsFilesApi } from "./useDocsFiles";
import { MAX_FILES } from "./useDocsFiles";
import { useFileDrop } from "./useFileDrop";
import { chipsRow, chipOn, chip, chipBtn, chipX, fileArea, dropHint, grayLine } from "./agentModalShared";

interface Props {
  pkg: DocsFilesApi;
  // Снятие файла крестиком: панель сбрасывает заодно отчёт и историю попыток.
  onRemove: (i: number) => void;
  // Текст пустой зоны приёма — что именно сюда тащат.
  dropText: string;
  // Подсказка кнопки вставки текстом.
  pasteTitle: string;
}

export default function AgentPackageInput({ pkg, onRemove, dropText, pasteTitle }: Props) {
  const fileRef = useRef<HTMLInputElement>(null);
  // Перетаскивание в ту же зону, что и кнопка загрузки. Расширения не сужаем:
  // состав пакета archmap-docs задаёт агент.
  const drop = useFileDrop({ onFiles: pkg.pickFiles, disabled: pkg.files.length >= MAX_FILES });

  return (
    <>
      <div style={chipsRow}>
        {pkg.files.map((f, i) => (
          <span key={f.name} style={i === pkg.active ? chipOn : chip}>
            <button type="button" style={chipBtn} title={f.name} onClick={() => pkg.setActive(i)}>
              {f.name}
            </button>
            <button type="button" style={chipX} title="Убрать файл" onClick={() => onRemove(i)}>×</button>
          </span>
        ))}
        <input
          ref={fileRef}
          type="file"
          multiple
          style={{ display: "none" }}
          onChange={(e) => { pkg.pickFiles(e.target.files); e.target.value = ""; }}
        />
        <button
          type="button"
          className="btn-soft"
          disabled={pkg.files.length >= MAX_FILES}
          onClick={() => fileRef.current?.click()}
        >
          Загрузить файлы…
        </button>
        <button
          type="button"
          className="btn-soft"
          disabled={pkg.files.length >= MAX_FILES}
          title={pasteTitle}
          onClick={pkg.addPaste}
        >
          + вставить из буфера
        </button>
      </div>

      <div className={drop.over ? "drop-zone--over" : undefined} {...drop.bind}>
        {pkg.files.length > 0 ? (
          <textarea
            style={fileArea}
            value={pkg.files[pkg.active]?.content ?? ""}
            onChange={(e) => pkg.setText(pkg.active, e.target.value)}
            placeholder="вставьте содержимое файла"
            spellCheck={false}
          />
        ) : (
          <button type="button" style={dropHint} onClick={() => fileRef.current?.click()}>
            {dropText}
          </button>
        )}
      </div>
      {drop.error && (
        <p style={{ ...grayLine, color: "#b45309", marginTop: 6 }}>{drop.error}</p>
      )}
      {/* Демо-стенд: файл больше предела не взят (docs/tasks/demo-mode.md). */}
      {pkg.sizeError && (
        <p style={{ ...grayLine, color: "#b91c1c", marginTop: 6 }}>{pkg.sizeError}</p>
      )}
    </>
  );
}
