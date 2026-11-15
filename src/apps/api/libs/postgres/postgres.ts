import { drizzle } from "drizzle-orm/postgres-js";
import type { Logger as DrizzleLogger } from "drizzle-orm";
import postgresjs from "postgresjs";
import { AppError } from "$api/libs/error/app_error.ts";
import { schema } from "$api/libs/postgres/schemas/mod.ts";

export type DbClient = ReturnType<typeof drizzle<typeof schema>>;
export type TxClient = Parameters<Parameters<DbClient["transaction"]>[0]>[0];

// ── Debug instrumentation ────────────────────────────────────────────────
// Ativado via `DEBUG_SQL=1`: imprime SQL + params + tempo/rows no stderr. O
// `#N` correlaciona a linha do SQL com a do resultado em queries concorrentes.

const DEBUG_SQL = Deno.env.get("DEBUG_SQL") === "1" ||
  Deno.env.get("DEBUG_SQL") === "true";

let queryCounter = 0;

function nextQueryId(): number {
  queryCounter += 1;
  return queryCounter;
}

/**
 * Hook "before" do Drizzle: imprime SQL + params com um id incremental. O
 * tempo final (rows + ms) é medido no wrapper de `query()` - o Drizzle não
 * expõe hook "after". O wrapper agrega se o caller correr várias queries.
 */
class DebugSqlLogger implements DrizzleLogger {
  private readonly enabled: boolean;
  // Último id atribuído, para o wrapper `query()` referenciar no log de "after".
  public lastQueryId = 0;

  constructor(enabled: boolean) {
    this.enabled = enabled;
  }

  logQuery(query: string, params: unknown[]): void {
    if (!this.enabled) return;
    this.lastQueryId = nextQueryId();
    console.error(`[sql #${this.lastQueryId}] ${query}`);
    if (params.length > 0) {
      console.error(`           params: ${JSON.stringify(params)}`);
    }
  }
}

const debugLogger = new DebugSqlLogger(DEBUG_SQL);

// Conta rows best-effort: array -> length; objeto com data/value/rows array ->
// length desse; resto -> "1". Só para o log de debug.
function inferRowCount(value: unknown): string {
  if (value === null || value === undefined) return "0";
  if (Array.isArray(value)) return String(value.length);
  if (typeof value === "object") {
    const v = value as Record<string, unknown>;
    if (Array.isArray(v.data)) return String((v.data as unknown[]).length);
    if (Array.isArray(v.value)) return String((v.value as unknown[]).length);
    if (Array.isArray(v.rows)) return String((v.rows as unknown[]).length);
    return "1";
  }
  return "1";
}

function logQueryCompleted(idLabel: string, value: unknown, ms: number) {
  if (!DEBUG_SQL) return;
  const rows = inferRowCount(value);
  const ms_fmt = ms < 10 ? ms.toFixed(2) : ms.toFixed(1);
  console.error(`           ✓ ${rows} rows in ${ms_fmt}ms ${idLabel}`);
}

export class Postgres {
  private sql;
  private db: DbClient;

  constructor() {
    const env = Deno.env.toObject();
    const databaseUrl = env.DATABASE_URL || "postgres://mague:mague@localhost:5432/mague";
    this.sql = postgresjs(databaseUrl, { max: 10 });
    // `logger` injecta `DebugSqlLogger` quando DEBUG_SQL=1 (no-op caso
    // contrário). Drizzle aceita boolean OR objeto; passar sempre o
    // logger é OK porque ele self-checks `enabled`.
    this.db = drizzle(this.sql, { schema, logger: debugLogger });
  }

  async query<T>(fn: (db: DbClient) => Promise<T>): Promise<T> {
    if (!DEBUG_SQL) {
      try {
        return await fn(this.db);
      } catch (e) {
        throw toAppError(e);
      }
    }
    const startMs = performance.now();
    try {
      const result = await fn(this.db);
      const elapsed = performance.now() - startMs;
      logQueryCompleted(`(#${debugLogger.lastQueryId})`, result, elapsed);
      return result;
    } catch (e) {
      const elapsed = performance.now() - startMs;
      const ms_fmt = elapsed < 10 ? elapsed.toFixed(2) : elapsed.toFixed(1);
      console.error(
        `           ✗ ERROR after ${ms_fmt}ms (#${debugLogger.lastQueryId}): ${
          e instanceof Error ? e.message : String(e)
        }`,
      );
      throw toAppError(e);
    }
  }

  async transaction<T>(fn: (tx: TxClient) => Promise<T>): Promise<T> {
    if (!DEBUG_SQL) {
      try {
        return await this.db.transaction(async (tx) => await fn(tx as TxClient));
      } catch (e) {
        throw toAppError(e);
      }
    }
    const startMs = performance.now();
    try {
      const result = await this.db.transaction(async (tx) => await fn(tx as TxClient));
      const elapsed = performance.now() - startMs;
      logQueryCompleted(`(tx #${debugLogger.lastQueryId})`, result, elapsed);
      return result;
    } catch (e) {
      const elapsed = performance.now() - startMs;
      const ms_fmt = elapsed < 10 ? elapsed.toFixed(2) : elapsed.toFixed(1);
      console.error(
        `           ✗ TX ERROR after ${ms_fmt}ms (#${debugLogger.lastQueryId}): ${
          e instanceof Error ? e.message : String(e)
        }`,
      );
      throw toAppError(e);
    }
  }
}

// Mapeia SQLSTATE Postgres -> {statusCode, code} semântico, em vez de cair
// sempre em 500 (violações de constraint são input inválido, não bug nosso).
// Ref: https://www.postgresql.org/docs/current/errcodes-appendix.html
function classifySqlState(sqlState: string): { statusCode: number; code: string } {
  switch (sqlState) {
    case "23505":
      return { statusCode: 409, code: "UNIQUE_VIOLATION" };
    case "23503":
      return { statusCode: 400, code: "FOREIGN_KEY_VIOLATION" };
    case "23502":
      return { statusCode: 400, code: "NOT_NULL_VIOLATION" };
    case "23514":
      return { statusCode: 400, code: "CHECK_VIOLATION" };
    case "23P01":
      return { statusCode: 409, code: "EXCLUSION_VIOLATION" };
    case "40001":
      return { statusCode: 409, code: "SERIALIZATION_FAILURE" };
    case "40P01":
      return { statusCode: 409, code: "DEADLOCK" };
  }
  // Classes (2 primeiros caracteres do SQLSTATE).
  const cls = sqlState.slice(0, 2);
  switch (cls) {
    case "22":
      return { statusCode: 400, code: "DATA_EXCEPTION" };
    case "08":
      return { statusCode: 503, code: "DB_UNAVAILABLE" };
    case "42":
      return { statusCode: 500, code: "DB_QUERY_ERROR" };
  }
  return { statusCode: 500, code: "DB_ERROR" };
}

function toAppError(e: unknown): AppError {
  if (e instanceof AppError) return e;

  // postgres-js anexa `code` (SQLSTATE) e `detail`/`constraint_name` aos erros.
  // Drizzle re-throws sem wrapping, por isso conseguimos sniff direto.
  if (e !== null && typeof e === "object" && "code" in e) {
    const sqlState = String((e as { code: unknown }).code ?? "");
    if (/^[0-9A-Z]{5}$/.test(sqlState)) {
      const { statusCode, code } = classifySqlState(sqlState);
      const message = e instanceof Error ? e.message : String(e);
      // Anexa detalhes úteis para debug sem expor SQL ao client final.
      const detail: Record<string, unknown> = { sqlState };
      if ("constraint_name" in e) {
        detail.constraint = (e as { constraint_name: unknown }).constraint_name;
      }
      if ("table_name" in e) {
        detail.table = (e as { table_name: unknown }).table_name;
      }
      return new AppError({ message, statusCode, code, detail });
    }
  }

  return new AppError({
    message: e instanceof Error ? e.message : String(e),
    statusCode: 500,
    code: "DB_ERROR",
  });
}

// Singleton partilhado por todos os routers - um único pool de 10 conexões
export const postgres = new Postgres();
