import { Controller, Get } from '@nestjs/common';

const ROUTE = 'ready';

@Controller()
export class HealthController {
  @Get('health')
  check() {
    return 'ok';
  }

  @Get(ROUTE)
  ready() {
    return 'ok';
  }
}
