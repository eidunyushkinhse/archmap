import { Controller, Get, Post } from '@nestjs/common';
import { Local, RouteKey } from '../enum';
import { Shared } from 'shared';

@Controller(RouteKey.Asset)
export class AssetController {
  @Get(':id')
  get() {}

  @Post()
  upload() {}
}

@Controller(RouteKey.User)
export class UserController {
  @Get('me')
  me() {}
}

@Controller(RouteKey.Count)
export class CountController {
  @Get()
  count() {}
}

@Controller(RouteKey.Missing)
export class MissingController {
  @Get()
  missing() {}
}

@Controller(Local.Api)
export class LocalController {
  @Get('x')
  x() {}
}

@Controller(Shared.Api)
export class SharedController {
  @Get('y')
  y() {}
}
