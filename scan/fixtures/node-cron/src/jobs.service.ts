import { Injectable } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { CronJob } from 'cron';
import { JobKey } from './enum';

@Injectable()
export class JobsService {
  @Cron('45 * * * * *')
  handleTick() {}

  @Cron(CronExpression.EVERY_HOUR, { name: 'hourly-report' })
  report() {}

  @Cron(CronExpression.EVERY_DAY_AT_3AM)
  async cleanupNight() {}

  @Cron(CronExpression.EVERY_QUARTER)
  quarterly() {}

  start() {
    const job = new CronJob('0 5 * * *', this.cleanup);
    const fromConfig = new CronJob(this.config.cleanup.cron, () => this.cleanup());
    this.cron.create({
      name: 'backupDatabase',
      expression: this.config.backup.cronExpression,
      onTick: () => this.backup(),
    });
    this.cron.create({
      name: JobKey.Sync,
      expression: '*/10 * * * *',
      onTick: () => this.jobs.queue({ name: 'inner' }),
    });
    const expression = `${minute} * * * *`;
    this.cron.create({ name: 'version-check', expression, onTick: () => this.check() });
    this.cron.update({ name: 'backupDatabase', expression: '0 1 * * *' });
    CronJob.from({ cronTime: '0 0 1 * *', onTick: monthly });
    // new CronJob('* * * * *', commented);
  }
}
