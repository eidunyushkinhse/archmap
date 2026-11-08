import z from 'zod';

const stringBool = z.stringbool();

export const EnvSchema = z
  .object({
    DB_HOSTNAME: z.string().optional(),
    DB_PORT: z.coerce.number().int().default(5432),
    DB_SSL: stringBool.optional(),
    LOG_LEVEL: z.enum(['debug', 'info', 'warn']).default('info'),
    API_SECRET: z.string(),
    SAMPLE_RATE: z.number().optional(),
    ['DYNAMIC_' + 'KEY']: z.string(),
  })
  .meta({ id: 'EnvDto' });

// Ловушка: схема тела запроса к окружению не применяется, это не параметры.
export const LoginSchema = z.object({ EMAIL: z.string(), PASSWORD: z.string() });
