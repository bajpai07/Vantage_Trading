import { Inject, Injectable } from '@nestjs/common';
import type pg from 'pg';
import { newId } from '../../ids.js';
import { POOL } from '../../tokens.js';

export interface UserRecord {
  readonly id: string;
  readonly email: string;
  readonly passwordHash: string;
  readonly role: string;
  readonly status: string;
  readonly displayName: string;
  readonly countryCode: string | null;
}

export interface NewUser {
  readonly email: string;
  readonly passwordHash: string;
  readonly displayName: string;
  readonly countryCode: string;
}

interface UserRow {
  id: string;
  email: string;
  password_hash: string;
  role: string;
  status: string;
  display_name: string;
  country_code: string | null;
}

const COLUMNS = `id, email::text AS email, password_hash, role::text AS role, status::text AS status,
                 display_name, country_code`;

const toRecord = (r: UserRow): UserRecord => ({
  id: r.id,
  email: r.email,
  passwordHash: r.password_hash,
  role: r.role,
  status: r.status,
  displayName: r.display_name,
  countryCode: r.country_code,
});

@Injectable()
export class UsersService {
  constructor(@Inject(POOL) private readonly pool: pg.Pool) {}

  /**
   * Inserts a user inside the caller's transaction. D-42: status ACTIVE and email_verified_at NULL until
   * email verification exists. Role is always USER and is_adult is true (the request proved it).
   */
  async createUser(client: Pick<pg.ClientBase, 'query'>, user: NewUser): Promise<string> {
    const id = newId();
    await client.query(
      `INSERT INTO users (id, email, password_hash, role, status, display_name, country_code, is_adult)
       VALUES ($1::uuid, $2, $3, 'USER', 'ACTIVE', $4, $5, true)`,
      [id, user.email, user.passwordHash, user.displayName, user.countryCode],
    );
    return id;
  }

  async findByEmail(email: string): Promise<UserRecord | undefined> {
    const r = await this.pool.query<UserRow>(
      `SELECT ${COLUMNS} FROM users WHERE email = $1 AND deleted_at IS NULL`,
      [email],
    );
    const row = r.rows[0];
    return row === undefined ? undefined : toRecord(row);
  }

  async findById(id: string): Promise<UserRecord | undefined> {
    const r = await this.pool.query<UserRow>(
      `SELECT ${COLUMNS} FROM users WHERE id = $1::uuid AND deleted_at IS NULL`,
      [id],
    );
    const row = r.rows[0];
    return row === undefined ? undefined : toRecord(row);
  }
}
