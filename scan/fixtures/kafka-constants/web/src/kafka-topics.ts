// Зеркало реестра на TypeScript (в духе nodejs/src/common/config/kafka-topics.ts).
const prefix = process.env.KAFKA_PREFIX || ''
export const KAFKA_EVENTS_JSON = `${prefix}clickhouse_events_json`
export const KAFKA_PLUGIN_LOGS = 'plugin_log_entries'
export const KAFKA_EMPTY = `${prefix}`
