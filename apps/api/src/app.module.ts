import { Module } from '@nestjs/common';
import { CommonModule } from './common/common.module.js';
import { AccountsModule } from './modules/accounts/accounts.module.js';
import { AuditModule } from './modules/audit/audit.module.js';
import { AuthModule } from './modules/auth/auth.module.js';
import { ConfigModule } from './modules/config/config.module.js';
import { DbModule } from './modules/db/db.module.js';
import { HealthModule } from './modules/health/health.module.js';
import { LedgerModule } from './modules/ledger/ledger.service.js';
import { UsersModule } from './modules/users/users.module.js';

@Module({
  imports: [
    ConfigModule,
    DbModule,
    CommonModule,
    HealthModule,
    AuditModule,
    LedgerModule,
    UsersModule,
    AccountsModule,
    AuthModule,
  ],
})
export class AppModule {}
