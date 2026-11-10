import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import type { Config } from '@vantage/config';
import { AppModule } from './app.module.js';
import { configureApp } from './configure-app.js';
import { createLogger } from './log.js';
import { CONFIG, LOGGER } from './tokens.js';
import type { Logger } from './log.js';

/** Starts the HTTP server on 127.0.0.1:PORT. Configuration must already have been validated. */
export async function startServer(): Promise<NestExpressApplication> {
  const app = await NestFactory.create<NestExpressApplication>(AppModule, { logger: false });
  const config = app.get<Config>(CONFIG);
  const logger = app.get<Logger>(LOGGER);
  configureApp(app, config, logger);
  app.enableShutdownHooks();
  await app.listen(config.port, '127.0.0.1');
  createLogger(config.logLevel).info('listening', { port: config.port });
  return app;
}
