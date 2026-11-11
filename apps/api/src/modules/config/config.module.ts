import { Global, Module } from '@nestjs/common';
import { loadConfigFromProcess } from '@vantage/config';
import type { Config } from '@vantage/config';
import { createLogger } from '../../log.js';
import { CLOCK, CONFIG, LOGGER, systemClock } from '../../tokens.js';

/** Application configuration (never migration credentials), the clock and the logger. */
@Global()
@Module({
  providers: [
    { provide: CONFIG, useFactory: (): Config => loadConfigFromProcess() },
    { provide: CLOCK, useValue: systemClock },
    {
      provide: LOGGER,
      inject: [CONFIG],
      useFactory: (config: Config) => createLogger(config.logLevel),
    },
  ],
  exports: [CONFIG, CLOCK, LOGGER],
})
export class ConfigModule {}
