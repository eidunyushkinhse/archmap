import express from 'express';
import { METRICS_PATH } from './constant';

export function mount(app: express.Application, config: { healthPath: string }) {
  app.get(METRICS_PATH, async (_req, res) => res.send('ok'));
  const { healthPath } = config;
  app.get(healthPath, (_req, res) => res.send('ok'));
  app.get('env');
  app.get(setting);
}
