import { Controller, Get } from '@nestjs/common';
import { USERS_PREFIX, ME_PATH } from './routes';

export class AppModule {}
export class ConfigRepository {}
export const ssr = AppModule;

@Controller(USERS_PREFIX)
export class UsersController {
  @Get(ME_PATH)
  me() {
    return 'me';
  }

  @Get(MISSING)
  other() {
    return 'x';
  }
}
