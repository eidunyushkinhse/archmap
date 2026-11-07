// Ловушка: код на языке своего контейнера остаётся его параметром.
const port = process.env.STREAMING_PORT || 4000;
module.exports = { port };
