import Koa from 'koa';
import Router from '@koa/router';

const app = new Koa();
const router = new Router({ prefix: '/api' });

router.get('/items', list);
router.del('/items/:id', remove);

app.use(router.routes());

function list() {}
function remove() {}
