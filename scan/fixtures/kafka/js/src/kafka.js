const { Kafka } = require('kafkajs');

const kafka = new Kafka({ clientId: 'app', brokers: ['kafka:9092'] });

async function run(producer, consumer, admin, env) {
  await producer.send({ topic: 'orders.created', messages: [{ value: 'x' }] });
  await consumer.subscribe({ topics: ['payments', 'refunds'], fromBeginning: true });
  await consumer.subscribe({ topic: `dyn.${env}` });
  await admin.createTopics({ topics: [{ topic: 'audit' }] });
}

module.exports = { kafka, run };
