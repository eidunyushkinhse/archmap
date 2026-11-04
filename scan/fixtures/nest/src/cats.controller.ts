import { All, Controller, Get, Post, Put } from '@nestjs/common';

@Controller('cats')
export class CatsController {
  @Get()
  findAll() {
    return [];
  }

  @Get(':id')
  findOne() {
    return {};
  }

  @Post()
  create() {
    return {};
  }

  // @Delete(':id') — строка в комментарии маршрутом не считается.
}

@Controller({ path: 'dogs', version: '1' })
export class DogsController {
  @Put(':id')
  update() {
    return {};
  }

  @All('*')
  any() {
    return {};
  }
}
