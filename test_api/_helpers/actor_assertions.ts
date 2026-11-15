// Helper para validar `created_by/updated_by/deleted_by` diretamente em
// PG. Conforme ADR 0011 (decisão Q11a=C), API responses NUNCA expõem actor
// fields - testes têm de consultar a BD diretamente.
//
// O cliente postgres reusa as credenciais default do projeto (`mague:mague@
// localhost:5432/mague`) - alinhado com docker-compose.yml em dev.

import { Client } from "https://deno.land/x/postgres@v0.17.2/mod.ts";
import { assertEquals, assertExists } from "@std/assert";

const DB_URL = Deno.env.get("DATABASE_URL") ??
  "postgres://mague:mague@localhost:5432/mague";

let client: Client | null = null;

async function getClient(): Promise<Client> {
  if (!client) {
    client = new Client(DB_URL);
    await client.connect();
  }
  return client;
}

export async function closeActorClient(): Promise<void> {
  if (client) {
    await client.end();
    client = null;
  }
}

export interface ActorAssertion {
  /** Schema-qualified table (e.g. `"finance.charge"`, `"core.\"user\""`). */
  table: string;
  /** Coluna do id da row (default: `id`). */
  idColumn?: string;
  /** Valor do id. */
  id: string;
  /** Coluna do actor a verificar (default: `created_by`). */
  column?: "created_by" | "updated_by" | "deleted_by";
  /** user_id esperado dentro do JSONB. */
  expectedUserId: string;
  /** Validar email/ip/user_agent/request_id presentes (recomendado para
   *  fluxos via API). Default: true. */
  expectFullActor?: boolean;
}

interface ActorRow {
  actor: {
    user_id?: string;
    email?: string;
    ip?: string;
    user_agent?: string;
    request_id?: string;
  };
}

/**
 * Carrega a row pelo id e asserta que o `column` (default created_by) tem
 * o `user_id` esperado. Quando `expectFullActor=true` (default), também
 * verifica que email, ip, user_agent e request_id estão presentes - sinal
 * de que o write veio via API com `requireActor`.
 */
export async function assertActor(opts: ActorAssertion): Promise<void> {
  const idCol = opts.idColumn ?? "id";
  const col = opts.column ?? "created_by";
  const expectFull = opts.expectFullActor ?? true;
  const cli = await getClient();

  const result = await cli.queryObject<ActorRow>(
    `SELECT ${col} AS actor FROM ${opts.table} WHERE ${idCol} = $1`,
    [opts.id],
  );
  if (result.rows.length === 0) {
    throw new Error(`assertActor: row ${opts.id} not found in ${opts.table}`);
  }
  const actor = result.rows[0].actor;
  if (!actor || typeof actor !== "object") {
    throw new Error(
      `assertActor: ${opts.table}.${col} for ${opts.id} is not an object: ${JSON.stringify(actor)}`,
    );
  }
  assertEquals(
    actor.user_id,
    opts.expectedUserId,
    `${opts.table}.${col}.user_id !== ${opts.expectedUserId}: ${JSON.stringify(actor)}`,
  );

  if (expectFull) {
    assertExists(actor.email, `${opts.table}.${col}.email missing`);
    assertExists(actor.user_agent, `${opts.table}.${col}.user_agent missing`);
    assertExists(actor.request_id, `${opts.table}.${col}.request_id missing`);
    // ip pode ser null se request vem do localhost sem proxy - não assertamos.
  }
}

/** Asserta que a coluna actor é `{}` (sem user - fluxos system-driven). */
export async function assertEmptyActor(
  opts: Omit<ActorAssertion, "expectedUserId" | "expectFullActor">,
): Promise<void> {
  const idCol = opts.idColumn ?? "id";
  const col = opts.column ?? "created_by";
  const cli = await getClient();

  const result = await cli.queryObject<{ actor: Record<string, unknown> }>(
    `SELECT ${col} AS actor FROM ${opts.table} WHERE ${idCol} = $1`,
    [opts.id],
  );
  if (result.rows.length === 0) {
    throw new Error(`assertEmptyActor: row ${opts.id} not found in ${opts.table}`);
  }
  assertEquals(
    result.rows[0].actor,
    {},
    `${opts.table}.${col} should be empty {} but was ${JSON.stringify(result.rows[0].actor)}`,
  );
}

/** Resolve o user_id do super (`super@mague.pt`) - usado pelos tests para
 *  comparar com o actor populated. Cached. */
let superUserId: string | null = null;
export async function getSuperUserId(): Promise<string> {
  if (superUserId) return superUserId;
  const cli = await getClient();
  const result = await cli.queryObject<{ id: string }>(
    `SELECT id FROM core."user" WHERE email = 'super@mague.pt' LIMIT 1`,
  );
  if (result.rows.length === 0) {
    throw new Error("getSuperUserId: super@mague.pt não existe - corre `deno task seed`");
  }
  superUserId = result.rows[0].id;
  return superUserId;
}
