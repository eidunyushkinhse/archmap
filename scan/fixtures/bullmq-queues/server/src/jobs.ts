import { Queue, Worker } from 'bullmq';
import { QueueName, QueueJobStatus } from './enum';

export const exportsQueue = new Queue('exports');
export function start(handler: () => void) {
  new Worker(QueueName.ThumbnailGeneration, handler);
  new Worker(QueueName['MetadataExtraction'], handler);
  for (const queueName of Object.values(QueueName)) new Worker(queueName, handler);
  return new Queue(QueueJobStatus.Active);
}
