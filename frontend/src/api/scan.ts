import type { ScanInfo } from "../types";
import { api } from "./client";

// Сборщик фактов ArchMap (scan/, docs/tasks/fact-collector.md): сервер раздаёт файл
// archmap-scan.pyz без входа. GET /scan называет версию, sha256 и размер, 404 — файла в
// этой поставке нет. Запрос мимо сессии: адрес публичный, как и сама ссылка на файл.
export const scanApi = {
  info: (): Promise<ScanInfo> => api.anon.get<ScanInfo>("/scan"),
  // Ссылка на сам файл: браузер скачивает её атрибутом download, без fetch и сессии.
  fileUrl: "/api/v1/scan/archmap-scan.pyz",
};
