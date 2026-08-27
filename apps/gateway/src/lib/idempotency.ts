import { createHash } from 'node:crypto';
import type { DB } from '../db.js';
import { Errors } from '../errors.js';

// DB-backed idempotency store (Blueprint §13, §32.1; idempotency-retry-contract.md §2).
// Fast path for all keyed mutations; the money/outcome paths ALSO have DB uniqueness
// constraints as the correctness backstop.

export function hashBody(body: unknown): string {
  return createHash('sha256').update(JSON.stringify(body ?? null)).digest('hex');
}

export interface StoredResponse {
  status_code: number;
  response_body: unknown;
}

// Returns a prior response if this (operation,key) was already processed with the same body,
// throws IDEMPOTENCY_KEY_REUSED on a body mismatch, or returns null to proceed.
export async function checkIdempotency(
  db: DB,
  operation: string,
  key: string,
  body: unknown,
): Promise<StoredResponse | null> {
  const reqHash = hashBody(body);
  const { rows } = await db.query(
    'select request_hash, status_code, response_body from ccat.idempotency_keys where operation=$1 and idem_key=$2',
    [operation, key],
  );
  if (rows.length === 0) return null;
  const row = rows[0]!;
  if (row.request_hash !== reqHash) throw Errors.idempotencyReuse();
  if (row.status_code == null) return null; // in-flight; let caller proceed (rare race)
  return { status_code: row.status_code, response_body: row.response_body };
}

export async function saveIdempotency(
  db: DB,
  operation: string,
  key: string,
  body: unknown,
  statusCode: number,
  responseBody: unknown,
): Promise<void> {
  await db.query(
    `insert into ccat.idempotency_keys(operation, idem_key, request_hash, status_code, response_body)
     values ($1,$2,$3,$4,$5)
     on conflict (operation, idem_key) do update
       set status_code=excluded.status_code, response_body=excluded.response_body`,
    [operation, key, hashBody(body), statusCode, JSON.stringify(responseBody)],
  );
}
