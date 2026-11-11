const Redis = require('ioredis');

const redis = new Redis();

async function done(id) {
  const pipeline = redis.pipeline();
  pipeline.publish('jobs:done', id);
  const tx = await this.redis.multi();
  tx.publish('jobs:tx', id);
  await pipeline.exec();
}

function trap(queue) {
  const batch = queue.pipeline();
  batch.publish('trap:queue', 1);
  other.publish('trap:other', 1);
}

module.exports = { done, trap };
