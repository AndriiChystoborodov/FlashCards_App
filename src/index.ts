import { env } from './config/env.js';

console.log(`Config OK (NODE_ENV=${env.NODE_ENV}, SLACK_MODE=${env.SLACK_MODE})`);
