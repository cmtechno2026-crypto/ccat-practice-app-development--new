import pg from 'pg';
const { Pool } = pg;

// SSL config for a Postgres connection, shared by the pool (createPool) and the migration runner so
// both connect identically. Supabase's session pooler REQUIRES SSL but presents a cert chain Node
// bundles no root for. CRUCIAL: node-postgres parses a `connectionString` and merges its `sslmode`
// OVER an explicit `ssl` option — so `sslmode=require` in DATABASE_URL (now escalated to verify-full)
// would win and reject the chain with "self-signed certificate in certificate chain". We therefore
// STRIP sslmode/ssl from the DSN and return an explicit `ssl` object that is authoritative. TLS stays
// ON; set PGSSL_REJECT_UNAUTHORIZED=true once the Supabase CA is pinned. Localhost → ssl undefined.
export function pgSslConfig(databaseUrl: string): { connectionString: string; ssl: pg.ClientConfig['ssl'] } {
  let connectionString = databaseUrl;
  let host = '';
  try {
    const u = new URL(databaseUrl);
    host = u.hostname;
    u.searchParams.delete('sslmode');
    u.searchParams.delete('ssl');
    connectionString = u.toString();
  } catch { /* not a parseable URL → treat as local, pass through unchanged */ }
  const isLocal = host === '' || host === 'localhost' || host === '127.0.0.1' || host === '::1';
  const ssl = isLocal ? undefined : { rejectUnauthorized: process.env.PGSSL_REJECT_UNAUTHORIZED === 'true' };
  return { connectionString, ssl };
}

// Single least-privilege connection pool. In production this authenticates as the
// `ccat_gateway` role (Blueprint §33, §36.3). search_path is pinned to the ccat schema.
export function createPool(databaseUrl: string): pg.Pool {
  // TLS + DSN handling is shared with the migration runner via pgSslConfig (see its doc comment):
  // it strips sslmode from the connectionString so our explicit ssl object wins, keeping TLS on for
  // Supabase and off for localhost.
  const { connectionString, ssl } = pgSslConfig(databaseUrl);
  // Pin search_path at connection time via libpq options — avoids a racing per-connect query.
  // NOTE: this connection-startup option is honored by a direct connection and by the Supabase
  // SESSION pooler (5432); the TRANSACTION pooler (6543) drops it, so it MUST NOT be used here.
  const pool = new Pool({ connectionString, max: 10, options: '-c search_path=ccat,public', ssl });
  // A pooled client can emit 'error' while idle (server restart, backend terminated, network
  // blip). Unhandled, that event crashes the process — so swallow it here; the pool discards the
  // bad client and the next query gets a fresh connection.
  pool.on('error', (err) => {
    // eslint-disable-next-line no-console
    console.warn('[pg pool] idle client error (recovered):', err.message);
  });
  return pool;
}

export type DB = pg.Pool;
export type Client = pg.PoolClient;

// Helper: run fn inside a transaction with automatic rollback on throw.
export async function withTransaction<T>(
  pool: pg.Pool,
  fn: (client: pg.PoolClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('begin');
    const result = await fn(client);
    await client.query('commit');
    return result;
  } catch (err) {
    await client.query('rollback');
    throw err;
  } finally {
    client.release();
  }
}
