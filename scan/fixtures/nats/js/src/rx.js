const { interval } = require('rxjs');

// Подписка RxJS, а не NATS.
interval(1000).subscribe((n) => n);
emitter.publish('not-nats', {});
