const Redis = require('ioredis');
const { CHANNEL } = require('./names');

const subscriber = new Redis();
const redisPub = new Redis();

subscriber.subscribe('orders:created', CHANNEL, (err, count) => {});
redisPub
  .publish(local ? 'notify:local' : 'notify:remote', 'x');
redisPub.publish(`notify:${id}`, 'x');
subscriber.psubscribe('notify:*');
emitter.publish('not-redis');
