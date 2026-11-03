export const config = {
  port: Number(process.env.PORT || 3000),
  host: process.env.HOST ?? '0.0.0.0',
  debug: process.env['DEBUG'] === 'true',
  token: process.env.API_TOKEN || 'dev-token-not-for-output',
  mode: process.env.NODE_ENV,
  // process.env.COMMENTED — строка в комментарии параметром не считается.
  dynamic: process.env[`PREFIX_${name}`],
};
