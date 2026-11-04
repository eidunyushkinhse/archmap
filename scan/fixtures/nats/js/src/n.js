const { connect, StringCodec } = require('nats');

async function run() {
  const nc = await connect({ servers: 'nats://nats:4222' });
  const sc = StringCodec();
  nc.subscribe('updates');
  nc.publish('updates.done', sc.encode('x'));
}

module.exports = { run };
