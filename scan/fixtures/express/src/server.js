const express = require('express');
const axios = require('axios');
const users = require('./users');

const app = express();
const orders = express.Router();

orders.get('/', (req, res) => res.json([]));
orders.post('/:id/pay', pay);
app.use('/orders', orders);

app.get('/health', (req, res) => res.send('ok'));

app.route('/books')
  .get(listBooks)
  .post(createBook);

// app.get('/commented', handler) — строка в комментарии маршрутом не считается.
axios.get('/api/external'); // вызов HTTP-клиента, а не маршрут

const PATH = '/dyn';
app.get(PATH, handler);
app.get(`/tmpl/${name}`, handler);

app.use('/users', users);

function pay() {}
function listBooks() {}
function createBook() {}
function handler() {}

// Склейка: путь собран из частей, маршрута «/files/» нет, есть подсказка.
app.get('/files/' + dir, handler);
// Ловушка: обычный литерал рядом остаётся маршрутом.
app.get('/plain', handler);
