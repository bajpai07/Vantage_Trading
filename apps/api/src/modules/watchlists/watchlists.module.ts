import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Inject,
  Injectable,
  Module,
  Param,
  Patch,
  Post,
  Put,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import type { PipeTransform } from '@nestjs/common';
import type { Response } from 'express';
import type pg from 'pg';
import {
  AddWatchlistItemRequest,
  CreateWatchlistRequest,
  ReorderWatchlistItemsRequest,
  SymbolSchema,
  UpdateWatchlistRequest,
  WATCHLIST_LIMITS,
  Watchlist as WatchlistSchema,
  WatchlistsResponse,
} from '@vantage/contracts';
import type { Watchlist } from '@vantage/contracts';
import { AppError } from '../../common/errors.js';
import type { AppRequest } from '../../common/http.js';
import { ZodValidationPipe } from '../../common/zod.pipe.js';
import { newId } from '../../ids.js';
import { POOL } from '../../tokens.js';
import { SessionGuard, SessionModule } from '../auth/session.guard.js';
import { InstrumentsModule, InstrumentsService } from '../instruments/instruments.module.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** A malformed list id is just "not found": nothing is revealed about other users' lists. */
class ListIdPipe implements PipeTransform<string, string> {
  transform(value: string): string {
    if (!UUID.test(value)) throw new AppError(404, 'WATCHLIST_NOT_FOUND', 'Watchlist not found');
    return value.toLowerCase();
  }
}

const notFound = (): AppError => new AppError(404, 'WATCHLIST_NOT_FOUND', 'Watchlist not found');
const limitReached = (): AppError =>
  new AppError(
    409,
    'WATCHLIST_LIMIT',
    `At most ${String(WATCHLIST_LIMITS.listsPerUser)} watchlists`,
  );
const listFull = (): AppError =>
  new AppError(
    409,
    'WATCHLIST_FULL',
    `At most ${String(WATCHLIST_LIMITS.itemsPerList)} instruments per watchlist`,
  );

function mapDbError(e: unknown): unknown {
  const err = e as { code?: string; constraint?: string } | null;
  if (err?.code === '23514' && err.constraint === 'watchlists_per_user_limit')
    return limitReached();
  if (err?.code === '23514' && err.constraint === 'watchlist_items_per_list_limit')
    return listFull();
  if (err?.code === '23505')
    return new AppError(409, 'WATCHLIST_NAME_TAKEN', 'You already have a watchlist with this name');
  return e;
}

interface Row {
  id: string;
  name: string;
  position: number;
  symbol: string | null;
  item_position: number | null;
}

/** Watchlists. Every query is scoped to the caller's user id, so other users' lists simply do not exist. */
@Injectable()
export class WatchlistsService {
  constructor(
    @Inject(POOL) private readonly pool: pg.Pool,
    @Inject(InstrumentsService) private readonly instruments: InstrumentsService,
  ) {}

  async list(userId: string): Promise<Watchlist[]> {
    const r = await this.pool.query<Row>(
      `SELECT w.id, w.name, w.position, i.symbol, wi.position AS item_position
         FROM watchlists w
         LEFT JOIN watchlist_items wi ON wi.watchlist_id = w.id
         LEFT JOIN instruments i ON i.id = wi.instrument_id
        WHERE w.user_id = $1::uuid
        ORDER BY w.position, w.name, wi.position, i.symbol`,
      [userId],
    );
    const lists = new Map<string, Watchlist>();
    for (const row of r.rows) {
      let l = lists.get(row.id);
      if (l === undefined) {
        l = { id: row.id, name: row.name, position: row.position, items: [] };
        lists.set(row.id, l);
      }
      if (row.symbol !== null && row.item_position !== null) {
        l.items.push({ symbol: row.symbol, position: row.item_position });
      }
    }
    return [...lists.values()];
  }

  async get(userId: string, id: string): Promise<Watchlist> {
    const found = (await this.list(userId)).find((l) => l.id === id);
    if (found === undefined) throw notFound();
    return found;
  }

  async create(userId: string, name: string): Promise<Watchlist> {
    // Service-level limit (the database trigger is the backstop for a bug or a race).
    const n = await this.pool.query<{ n: string; next: number }>(
      `SELECT count(*) AS n, COALESCE(max(position), -1) + 1 AS next FROM watchlists WHERE user_id = $1::uuid`,
      [userId],
    );
    if (Number(n.rows[0]?.n) >= WATCHLIST_LIMITS.listsPerUser) throw limitReached();
    const id = newId();
    try {
      await this.pool.query(
        `INSERT INTO watchlists (id, user_id, name, position) VALUES ($1::uuid, $2::uuid, $3, $4::int)`,
        [id, userId, name, n.rows[0]?.next ?? 0],
      );
    } catch (e) {
      throw mapDbError(e);
    }
    return this.get(userId, id);
  }

  async update(userId: string, id: string, patch: UpdateWatchlistRequest): Promise<Watchlist> {
    try {
      const r = await this.pool.query(
        `UPDATE watchlists SET name = COALESCE($3, name), position = COALESCE($4::int, position)
          WHERE id = $1::uuid AND user_id = $2::uuid`,
        [id, userId, patch.name ?? null, patch.position ?? null],
      );
      if (r.rowCount === 0) throw notFound();
    } catch (e) {
      throw mapDbError(e);
    }
    return this.get(userId, id);
  }

  async remove(userId: string, id: string): Promise<void> {
    const r = await this.pool.query(
      `DELETE FROM watchlists WHERE id = $1::uuid AND user_id = $2::uuid`,
      [id, userId],
    );
    if (r.rowCount === 0) throw notFound();
  }

  /** Adds an instrument. Adding one that is already there is an idempotent no-op (created: false). */
  async addItem(
    userId: string,
    id: string,
    symbol: string,
  ): Promise<{ list: Watchlist; created: boolean }> {
    await this.get(userId, id); // 404 for a list that is not the caller's
    const [instrument] = await this.instruments.findBySymbols([symbol]);
    if (instrument === undefined)
      throw new AppError(404, 'INSTRUMENT_NOT_FOUND', 'Instrument not found');
    const c = await this.pool.query<{ n: string; next: number }>(
      `SELECT count(*) AS n, COALESCE(max(position), -1) + 1 AS next FROM watchlist_items WHERE watchlist_id = $1::uuid`,
      [id],
    );
    const exists = await this.pool.query(
      `SELECT 1 FROM watchlist_items WHERE watchlist_id = $1::uuid AND instrument_id = $2::uuid`,
      [id, instrument.id],
    );
    if ((exists.rowCount ?? 0) > 0) return { list: await this.get(userId, id), created: false };
    if (Number(c.rows[0]?.n) >= WATCHLIST_LIMITS.itemsPerList) throw listFull();
    let created: boolean;
    try {
      const r = await this.pool.query(
        `INSERT INTO watchlist_items (watchlist_id, instrument_id, position)
         VALUES ($1::uuid, $2::uuid, $3::int) ON CONFLICT (watchlist_id, instrument_id) DO NOTHING`,
        [id, instrument.id, c.rows[0]?.next ?? 0],
      );
      created = (r.rowCount ?? 0) > 0;
    } catch (e) {
      throw mapDbError(e);
    }
    return { list: await this.get(userId, id), created };
  }

  /** Removing an instrument that is not in the list is an idempotent no-op. */
  async removeItem(userId: string, id: string, symbol: string): Promise<void> {
    await this.get(userId, id);
    await this.pool.query(
      `DELETE FROM watchlist_items wi USING instruments i
        WHERE wi.watchlist_id = $1::uuid AND wi.instrument_id = i.id AND upper(i.symbol) = $2`,
      [id, symbol.toUpperCase()],
    );
  }

  /** `symbols` must be exactly the symbols currently in the list, in the new order. */
  async reorder(userId: string, id: string, symbols: readonly string[]): Promise<Watchlist> {
    const current = await this.get(userId, id);
    const have = current.items.map((i) => i.symbol.toUpperCase()).sort();
    const want = [...symbols].map((s) => s.toUpperCase()).sort();
    if (have.length !== want.length || have.some((s, i) => s !== want[i])) {
      throw new AppError(
        400,
        'ORDER_MISMATCH',
        'The order must list exactly the symbols in the watchlist',
      );
    }
    await this.pool.query(
      `UPDATE watchlist_items wi SET position = o.pos
         FROM (SELECT s.symbol, s.pos FROM unnest($2::text[]) WITH ORDINALITY AS s(symbol, pos)) o
         JOIN instruments i ON upper(i.symbol) = o.symbol
        WHERE wi.watchlist_id = $1::uuid AND wi.instrument_id = i.id`,
      [id, symbols.map((s) => s.toUpperCase())],
    );
    return this.get(userId, id);
  }
}

const userOf = (req: AppRequest): string => {
  if (req.auth === undefined) throw new AppError(401, 'UNAUTHENTICATED', 'Authentication required');
  return req.auth.userId;
};

@Controller('v1/watchlists')
@UseGuards(SessionGuard)
export class WatchlistsController {
  constructor(@Inject(WatchlistsService) private readonly lists: WatchlistsService) {}

  @Get()
  async all(@Req() req: AppRequest): Promise<WatchlistsResponse> {
    return WatchlistsResponse.parse({ watchlists: await this.lists.list(userOf(req)) });
  }

  @Post()
  @HttpCode(201)
  async create(
    @Body(new ZodValidationPipe(CreateWatchlistRequest)) body: CreateWatchlistRequest,
    @Req() req: AppRequest,
  ): Promise<Watchlist> {
    return WatchlistSchema.parse(await this.lists.create(userOf(req), body.name));
  }

  @Patch(':id')
  async update(
    @Param('id', new ListIdPipe()) id: string,
    @Body(new ZodValidationPipe(UpdateWatchlistRequest)) body: UpdateWatchlistRequest,
    @Req() req: AppRequest,
  ): Promise<Watchlist> {
    return WatchlistSchema.parse(await this.lists.update(userOf(req), id, body));
  }

  @Delete(':id')
  @HttpCode(204)
  async remove(@Param('id', new ListIdPipe()) id: string, @Req() req: AppRequest): Promise<void> {
    await this.lists.remove(userOf(req), id);
  }

  /** 201 when the instrument was added, 200 when it was already there (idempotent). */
  @Post(':id/items')
  async addItem(
    @Param('id', new ListIdPipe()) id: string,
    @Body(new ZodValidationPipe(AddWatchlistItemRequest)) body: AddWatchlistItemRequest,
    @Req() req: AppRequest,
    @Res({ passthrough: true }) res: Response,
  ): Promise<Watchlist> {
    const { list, created } = await this.lists.addItem(userOf(req), id, body.symbol);
    res.status(created ? 201 : 200);
    return WatchlistSchema.parse(list);
  }

  @Put(':id/items/order')
  async reorder(
    @Param('id', new ListIdPipe()) id: string,
    @Body(new ZodValidationPipe(ReorderWatchlistItemsRequest)) body: ReorderWatchlistItemsRequest,
    @Req() req: AppRequest,
  ): Promise<Watchlist> {
    return WatchlistSchema.parse(await this.lists.reorder(userOf(req), id, body.symbols));
  }

  @Delete(':id/items/:symbol')
  @HttpCode(204)
  async removeItem(
    @Param('id', new ListIdPipe()) id: string,
    @Param('symbol', new ZodValidationPipe(SymbolSchema)) symbol: string,
    @Req() req: AppRequest,
  ): Promise<void> {
    await this.lists.removeItem(userOf(req), id, symbol);
  }
}

@Module({
  imports: [SessionModule, InstrumentsModule],
  controllers: [WatchlistsController],
  providers: [WatchlistsService],
})
export class WatchlistsModule {}
