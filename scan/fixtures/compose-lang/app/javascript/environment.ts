// Браузерный код в каталоге процессов Ruby: не параметр ни web, ни sidekiq.
export const isProduction = process.env.NODE_ENV === 'production';
