import { BullModule, InjectQueue, Processor } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { QueueName } from './enum';

export const queues = BullModule.registerQueue({ name: 'reports' }, { name: QueueName.Notification });
@Processor({ name: 'reports' })
export class ReportsProcessor {
  constructor(@InjectQueue('exports') private readonly queue: Queue) {}
}
