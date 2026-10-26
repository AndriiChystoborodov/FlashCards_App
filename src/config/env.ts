import 'dotenv/config';
import { z } from 'zod';

const isIanaTimezone = (tz: string): boolean => {
  try {
    new Intl.DateTimeFormat('en', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
};

const envSchema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    SLACK_MODE: z.enum(['socket', 'http']).default('socket'),
    SLACK_BOT_TOKEN: z.string().startsWith('xoxb-', 'must start with "xoxb-"'),
    SLACK_APP_TOKEN: z.string().startsWith('xapp-', 'must start with "xapp-"'),
    SLACK_SIGNING_SECRET: z.string().optional(),
    SLACK_TEST_USER_ID: z.string().optional(),
    TENANT_TIMEZONE: z.string().refine(isIanaTimezone, 'must be a valid IANA time zone name').default('UTC'),
    SEND_HOUR: z.coerce.number().int().min(0).max(23).default(9),
    TICK_MINUTES: z.coerce.number().int().positive().default(15),
    REMOVED_RETENTION_DAYS: z.coerce.number().int().positive().default(14),
    STUDENT_ROUTES_ENABLED: z
      .enum(['true', 'false'], 'must be "true" or "false"')
      .default('false')
      .transform((v) => v === 'true'),
    DATABASE_URL: z.string().optional(),
  })
  .superRefine((e, ctx) => {
    if (e.SLACK_MODE === 'http' && !e.SLACK_SIGNING_SECRET) {
      ctx.addIssue({ code: 'custom', path: ['SLACK_SIGNING_SECRET'], message: 'required when SLACK_MODE=http' });
    }
    if (e.SLACK_MODE === 'socket' && !e.SLACK_TEST_USER_ID) {
      ctx.addIssue({ code: 'custom', path: ['SLACK_TEST_USER_ID'], message: 'required when SLACK_MODE=socket' });
    }
    if (!e.DATABASE_URL && e.NODE_ENV !== 'test') {
      ctx.addIssue({ code: 'custom', path: ['DATABASE_URL'], message: 'required unless NODE_ENV=test' });
    }
    if (e.STUDENT_ROUTES_ENABLED && e.NODE_ENV === 'production') {
      ctx.addIssue({
        code: 'custom',
        path: ['STUDENT_ROUTES_ENABLED'],
        message: 'must not be "true" when NODE_ENV=production (decision 0018)',
      });
    }
  });

export type Env = z.infer<typeof envSchema>;

// Empty values (as in .env.example) count as unset, so defaults and "required" checks apply.
export function parseEnv(source: Record<string, string | undefined>): Env {
  const cleaned = Object.fromEntries(Object.entries(source).filter(([, v]) => v !== ''));
  const result = envSchema.safeParse(cleaned);
  if (!result.success) {
    // Only variable names and rules are printed, never values (they may be tokens).
    const lines = result.error.issues.map((i) => `  ${i.path.join('.')}: ${i.message}`);
    throw new Error(`Invalid environment:\n${lines.join('\n')}`);
  }
  return result.data;
}

export const env: Env = parseEnv(process.env);
