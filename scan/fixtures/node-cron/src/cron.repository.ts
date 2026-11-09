import { CronJob } from 'cron';

// Тип и разбор параметра с теми же ключами не регистрации.
export type CronCreate = {
  name: string;
  expression: string;
  onTick: () => void;
};

export class CronRepository {
  create({ name, expression, onTick }: CronCreate): void {
    const job = new CronJob(expression, onTick);
    job.start();
  }

  register = ({ expression, onTick }) => new CronJob(expression, onTick);
}
