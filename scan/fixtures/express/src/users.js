const router = require('express').Router();

// Роутер подключается в другом файле: префикс отсюда не виден.
router.get('/:id', (req, res) => res.json({}));

module.exports = router;
