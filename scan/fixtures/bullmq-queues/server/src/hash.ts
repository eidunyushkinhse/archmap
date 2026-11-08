import { Worker } from 'node:worker_threads';
import { Queue } from 'bullmq';
// Ловушка: поток Node.js, а не потребитель очереди.
export const hashing = new Worker('./hash-file.js');
export const hashed = new Queue('hashed');
