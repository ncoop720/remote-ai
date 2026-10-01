import { startServer } from './app.js';
import { loadConfig } from './config.js';

await startServer({ config: loadConfig() });
