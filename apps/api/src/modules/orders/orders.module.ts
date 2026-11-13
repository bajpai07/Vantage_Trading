import {
  Controller,
  Get,
  Headers,
  HttpCode,
  Inject,
  Injectable,
  Module,
  Param,
  Post,
  Query,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import type { CanActivate, ExecutionContext, PipeTransform } from '@nestjs/common';
import type { Response } from 'express';
import type { Config } from '@vantage/config';
import type { OrderPreviewResponse, OrderResponse } from '@vantage/contracts';
import {
  IDEMPOTENCY_KEY_PATTERN,
  ListOrdersQuery,
  ListOrdersResponse,
  PlaceOrderRequest,
  PositionsResponse,
  PreviewOrderRequest,
} from '@vantage/contracts';
import { AppError, unauthenticated } from '../../common/errors.js';
import { clientIp } from '../../common/http.js';
import type { AppRequest } from '../../common/http.js';
import { ZodValidationPipe } from '../../common/zod.pipe.js';
import type { Logger } from '../../log.js';
import {
  CLOCK,
  CONFIG,
  LOGGER,
  ORDER_HOOKS,
  ORDER_LIMITER,
  ORDER_PREVIEW_LIMITER,
} from '../../tokens.js';
import type { Clock } from '../../tokens.js';
import { AuditModule } from '../audit/audit.module.js';
import { SessionGuard, SessionModule } from '../auth/session.guard.js';
import { RateLimiter } from '../auth/rate-limiter.js';
import { MarketDataModule } from '../market-data/market-data.module.js';
import { OrdersService, orderNotFound } from './orders.service.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** A malformed order id is just "not found": nothing is revealed about other users' orders. */
class OrderIdPipe implements PipeTransform<string, string> {
  transform(value: string): string {
    if (!UUID.test(value)) throw orderNotFound();
    return value.toLowerCase();
  }
}

const userOf = (req: AppRequest): string => {
  if (req.auth === undefined) throw unauthenticated();
  return req.auth.userId;
};

/**
 * Order placement limit per user (D-58 amendment: 30 per minute by default, ORDER_RATE_LIMIT_PER_MINUTE).
 * LIMITATION: in memory and per process (the M2 limiter); several API processes each count separately and a
 * restart clears the counters. Every request that reaches the endpoint after authentication counts, replays
 * included. Runs after SessionGuard, so an anonymous caller gets 401 and never touches a user's allowance.
 */
@Injectable()
export class OrderRateLimitGuard implements CanActivate {
  constructor(
    @Inject(ORDER_LIMITER) private readonly limiter: RateLimiter,
    @Inject(LOGGER) private readonly logger: Logger,
  ) {}

  canActivate(context: ExecutionContext): boolean {
    const req = context.switchToHttp().getRequest<AppRequest>();
    const userId = userOf(req);
    if (this.limiter.tryConsume(userId)) return true;
    const retryAfter = this.limiter.retryAfterSeconds(userId);
    this.logger.warn('rate_limited', { route: 'POST /v1/orders', retryAfterSeconds: retryAfter });
    throw new AppError(429, 'RATE_LIMITED', 'Too many orders. Try again later.', {
      'Retry-After': String(retryAfter),
    });
  }
}

/**
 * Order preview limit per user (D-70: 60 per minute by default, ORDER_PREVIEW_RATE_LIMIT_PER_MINUTE). Its own counter,
 * so previews never use up the allowance for placing orders. In memory and per process, like the order limit.
 */
@Injectable()
export class OrderPreviewRateLimitGuard implements CanActivate {
  constructor(
    @Inject(ORDER_PREVIEW_LIMITER) private readonly limiter: RateLimiter,
    @Inject(LOGGER) private readonly logger: Logger,
  ) {}

  canActivate(context: ExecutionContext): boolean {
    const req = context.switchToHttp().getRequest<AppRequest>();
    const userId = userOf(req);
    if (this.limiter.tryConsume(userId)) return true;
    const retryAfter = this.limiter.retryAfterSeconds(userId);
    this.logger.warn('rate_limited', {
      route: 'POST /v1/orders/preview',
      retryAfterSeconds: retryAfter,
    });
    throw new AppError(429, 'RATE_LIMITED', 'Too many previews. Try again shortly.', {
      'Retry-After': String(retryAfter),
    });
  }
}

@Controller('v1/orders')
@UseGuards(SessionGuard)
export class OrdersController {
  constructor(@Inject(OrdersService) private readonly orders: OrdersService) {}

  /**
   * Places a MARKET order. 201 with the order, FILLED or REJECTED (a business reject is an order, not an HTTP
   * error). A replay of the same Idempotency-Key and request returns the stored status and body.
   */
  @Post()
  @HttpCode(201)
  @UseGuards(OrderRateLimitGuard)
  async place(
    @Headers('idempotency-key') key: string | undefined,
    @Req() req: AppRequest,
    @Res({ passthrough: true }) res: Response,
  ): Promise<OrderResponse> {
    if (key === undefined || !IDEMPOTENCY_KEY_PATTERN.test(key)) {
      throw new AppError(
        400,
        'IDEMPOTENCY_KEY_INVALID',
        'Idempotency-Key header is required: 8 to 128 characters from A-Z a-z 0-9 . _ : -',
      );
    }
    const body = new ZodValidationPipe(PlaceOrderRequest).transform(req.body);
    const placed = await this.orders.place(userOf(req), key, body, {
      requestId: req.requestId,
      ip: clientIp(req),
    });
    res.status(placed.status);
    return placed.body;
  }

  /**
   * Previews a MARKET order: what it would do right now (D-70). Same validated body as placing an order, no
   * Idempotency-Key, nothing stored or locked. 200, not 201: nothing is created. Advisory only.
   */
  @Post('preview')
  @HttpCode(200)
  @UseGuards(OrderPreviewRateLimitGuard)
  async preview(@Req() req: AppRequest): Promise<OrderPreviewResponse> {
    const body = new ZodValidationPipe(PreviewOrderRequest).transform(req.body);
    return this.orders.preview(userOf(req), body);
  }

  @Get()
  async list(
    @Query(new ZodValidationPipe(ListOrdersQuery)) query: ListOrdersQuery,
    @Req() req: AppRequest,
  ): Promise<ListOrdersResponse> {
    return ListOrdersResponse.parse(await this.orders.list(userOf(req), query));
  }

  @Get(':id')
  async one(
    @Param('id', new OrderIdPipe()) id: string,
    @Req() req: AppRequest,
  ): Promise<OrderResponse> {
    return this.orders.get(userOf(req), id);
  }
}

@Controller('v1/positions')
@UseGuards(SessionGuard)
export class PositionsController {
  constructor(@Inject(OrdersService) private readonly orders: OrdersService) {}

  /** Open positions from the positions cache: quantity and average cost only (no market value or P&L yet). */
  @Get()
  async list(@Req() req: AppRequest): Promise<PositionsResponse> {
    return PositionsResponse.parse({ positions: await this.orders.positions(userOf(req)) });
  }
}

@Module({
  imports: [SessionModule, MarketDataModule, AuditModule],
  controllers: [OrdersController, PositionsController],
  providers: [
    OrdersService,
    OrderRateLimitGuard,
    OrderPreviewRateLimitGuard,
    {
      provide: ORDER_PREVIEW_LIMITER,
      inject: [CONFIG, CLOCK],
      useFactory: (config: Config, clock: Clock) =>
        new RateLimiter({
          limit: config.orderPreviewRateLimitPerMinute,
          windowMs: 60_000,
          now: () => clock.now().getTime(),
        }),
    },
    {
      provide: ORDER_LIMITER,
      inject: [CONFIG, CLOCK],
      useFactory: (config: Config, clock: Clock) =>
        new RateLimiter({
          limit: config.orderRateLimitPerMinute,
          windowMs: 60_000,
          now: () => clock.now().getTime(),
        }),
    },
    { provide: ORDER_HOOKS, useValue: {} },
  ],
})
export class OrdersModule {}
