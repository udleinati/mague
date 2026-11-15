import {
  Pool,
  type PoolClient,
  type QueryArguments,
  type QueryObjectResult,
} from "postgres/mod.ts";
import { env, isDev } from "../config/env.ts";

const POOL_SIZE = 10;

const pool = new Pool(env.databaseUrl, POOL_SIZE, true);

// Em dev faz log do SQL/params. Use sempre parâmetros (`$1`, ...), nunca interpole.
// deno-postgres exige `Record<string, unknown>` para rows tipadas; o cast deixa
// callers passar interfaces simples (sem index signature) sem fricção.
// deno-lint-ignore no-explicit-any
export async function query<T = any>(
  sql: string,
  params: QueryArguments = [],
): Promise<QueryObjectResult<T>> {
  const start = isDev ? performance.now() : 0;
  const client = await pool.connect();
  try {
    const result = await client.queryObject<T>(sql, params);
    if (isDev) {
      const ms = (performance.now() - start).toFixed(1);
      console.log(`[sql ${ms}ms] ${oneLine(sql)}`, params.length ? params : "");
    }
    return result;
  } finally {
    client.release();
  }
}

/**
 * BEGIN antes, COMMIT/ROLLBACK no fim consoante o resultado.
 * @example
 * await transaction(async (tx) => {
 *   await tx.queryObject("INSERT INTO ...");
 *   await tx.queryObject("UPDATE ...");
 * });
 */
export async function transaction<T>(
  callback: (tx: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.queryObject("BEGIN");
    const result = await callback(client);
    await client.queryObject("COMMIT");
    return result;
  } catch (err) {
    await client.queryObject("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

// Chamar em graceful shutdown.
export async function closePool(): Promise<void> {
  await pool.end();
}

const shutdown = async (signal: string) => {
  if (isDev) {
    // Em dev deixamos o watcher gerir o reinício.
    await closePool();
    return;
  }

  console.log(`\nA encerrar (${signal})...`);
  try {
    const timeout = setTimeout(() => Deno.exit(0), 1000);
    await closePool();
    clearTimeout(timeout);
  } catch { /* ignore */ }
  Deno.exit(0);
};

Deno.addSignalListener("SIGINT", () => shutdown("SIGINT"));
try {
  // SIGTERM não existe em Windows
  Deno.addSignalListener("SIGTERM", () => shutdown("SIGTERM"));
} catch { /* ignore */ }

function oneLine(sql: string): string {
  return sql.replace(/\s+/g, " ").trim();
}
