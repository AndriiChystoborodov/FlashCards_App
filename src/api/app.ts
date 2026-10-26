import express, { type Express } from 'express';
import type { SchedulerDeps } from '../services/scheduler.js';
import { errorHandler, notFoundHandler } from './errors.js';
import { assertStudentRoutesAllowed } from './loopback.js';
import { studentRouter } from './student.js';
import { teacherRouter } from './teacher.js';

export interface ApiDeps extends SchedulerDeps {
  removedRetentionDays: number;
  /** env STUDENT_ROUTES_ENABLED (decision 0018); the env schema refuses it in production and `createApp` refuses it off loopback. */
  studentRoutesEnabled: boolean;
  /** The host the server will bind to; `startServer` listens on it. Required, so the loopback check cannot be skipped. */
  bindHost: string;
}

/** The Express app of docs/rest-api.md. It does not listen (use `startServer`). Throws when student routes are enabled for a non-loopback host. */
export function createApp(deps: ApiDeps): Express {
  assertStudentRoutesAllowed(deps.studentRoutesEnabled, deps.bindHost);
  const app = express();
  app.disable('x-powered-by');
  if (deps.studentRoutesEnabled) app.use(studentRouter(deps));
  app.use(teacherRouter(deps, deps.removedRetentionDays));
  app.use(notFoundHandler);
  app.use(errorHandler);
  return app;
}
