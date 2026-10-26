import express, { type Express } from 'express';
import type { SchedulerDeps } from '../services/scheduler.js';
import { errorHandler, notFoundHandler } from './errors.js';
import { studentRouter } from './student.js';
import { teacherRouter } from './teacher.js';

export interface ApiDeps extends SchedulerDeps {
  removedRetentionDays: number;
  /** env STUDENT_ROUTES_ENABLED (decision 0018); the env schema refuses it in production. */
  studentRoutesEnabled: boolean;
}

/** The Express app of docs/rest-api.md. It does not listen: the caller (tests, scenario, Task 8's index.ts) chooses host and port. */
export function createApp(deps: ApiDeps): Express {
  const app = express();
  app.disable('x-powered-by');
  if (deps.studentRoutesEnabled) app.use(studentRouter(deps));
  app.use(teacherRouter(deps, deps.removedRetentionDays));
  app.use(notFoundHandler);
  app.use(errorHandler);
  return app;
}
