/** What to log for a caught error: its name and a short message. Drizzle and Slack errors can carry query parameters or request data, so the error object itself is never logged. */
export const errText = (e: unknown): string => (e instanceof Error ? `${e.name}: ${e.message.slice(0, 200)}` : 'unknown error');
