import z from 'zod';
import { EnvSchema } from 'src/dtos/env.dto.js';
import { LoginSchema } from './dtos/env.dto';

export const env = EnvSchema.safeParse(process.env);
export const login = (body: unknown) => LoginSchema.parse(body);

const Local = z.object({ WORKER_COUNT: z.coerce.number().default(2) });
export const local = Local.parse(process.env);
