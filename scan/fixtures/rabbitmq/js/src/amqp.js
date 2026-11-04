const amqp = require('amqplib');

async function run(queueName, buf) {
  const conn = await amqp.connect('amqp://rabbitmq');
  const ch = await conn.createChannel();
  await ch.assertQueue('tasks', { durable: true });
  await ch.assertExchange('logs', 'fanout');
  await ch.bindQueue('tasks', 'logs', '');
  ch.sendToQueue('tasks', Buffer.from('x'));
  ch.publish('logs', '', Buffer.from('x'));
  ch.publish('', 'tasks', Buffer.from('x'));
  await ch.consume('tasks', (msg) => msg);
  ch.sendToQueue(queueName, buf);
}

module.exports = { run };
