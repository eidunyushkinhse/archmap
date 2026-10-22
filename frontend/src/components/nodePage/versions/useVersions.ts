// Загрузки панели версий: список, дельта версии, один элемент. Каждая — useAsyncLoad по
// ключу: отказ приходит состоянием error (его показывает ui/LoadError с «Повторить»), а
// ответ по устаревшему ключу (быстро сменили версию или «с чем сравнивать») не
// применяется. Ключ несёт срез: объект или весь проект (nodeId = null).
import { useAsyncLoad } from "../../../lib/useAsyncLoad";
import type { AsyncLoad } from "../../../lib/useAsyncLoad";
import { versionsApi } from "../../../api/versions";
import type { VersionBase } from "../../../api/versions";
import type { VersionDiff, VersionItemDetail, VersionList } from "../../../types";

const scope = (nodeId: string | null): string => nodeId ?? "project";

export function useVersionList(nodeId: string | null): AsyncLoad<VersionList> {
  return useAsyncLoad(`versions:${scope(nodeId)}`, () => versionsApi.list(nodeId));
}

export function useVersionDiff(nodeId: string | null, num: number, base: VersionBase): AsyncLoad<VersionDiff> {
  return useAsyncLoad(`diff:${scope(nodeId)}:${num}:${base}`, () => versionsApi.diff(nodeId, num, base));
}

export function useVersionItem(
  nodeId: string | null, num: number, itemId: string, base: VersionBase,
): AsyncLoad<VersionItemDetail> {
  return useAsyncLoad(
    `item:${scope(nodeId)}:${num}:${base}:${itemId}`,
    () => versionsApi.item(nodeId, num, itemId, base),
  );
}
