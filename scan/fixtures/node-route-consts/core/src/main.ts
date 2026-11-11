import { NestFactory } from '@nestjs/core';
import { HEALTH_PATH } from 'lib-a';
import { AppModule, ConfigRepository, ssr } from './app';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  const config = app.get(ConfigRepository);
  app.get(ConfigRepository, { strict: false }).getEnv();
  app.use(app.get(ssr).ssr([]));
  app.get(HEALTH_PATH, (_req, res) => res.send(config));
}
