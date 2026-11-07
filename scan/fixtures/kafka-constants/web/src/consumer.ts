import { Kafka } from 'kafkajs'
import { KAFKA_EVENTS_JSON, KAFKA_PLUGIN_LOGS as LOGS } from './kafka-topics'

const kafka = new Kafka({ brokers: ['kafka:9092'] })
await kafka.consumer({ groupId: 'g' }).subscribe({ topics: [KAFKA_EVENTS_JSON, LOGS] })
const localTopic = 'x'
await kafka.producer().send({ topic: localTopic, messages: [] })
