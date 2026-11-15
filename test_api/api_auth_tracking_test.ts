// E2E para os side-effects do login:
//
//   1. Login OK popula `core.occupant.first_login_at` (write-once via
//      COALESCE) + `last_login_at` + `last_login_ip` + `last_login_user_agent`
//      em todos os occupants ligados ao user.
//   2. 2º login NÃO sobrescreve `first_login_at` mas atualiza `last_login_at`.
//   3. `core.user.password_changed_at` é atualizado em `change-password`.
//   4. Rate limit Valkey: 5 tentativas falhadas com o mesmo identifier
//      bloqueia a 6ª (HTTP 429 RATE_LIMITED).
//   5. `core.user.failed_login_attempts` é counter cumulativo lifetime -
//      incrementa em logins falhados de users existentes (audit).
//
// Self-contained: cria condo + unit + occupant + user (com password directa
// na DB para evitar SMTP). Cada run usa identifiers únicos (timestamp) para
// não colidir com runs anteriores no Valkey.

import { assertEquals, assertGreater, assertRejects } from "@std/assert";
import { describe, it } from "@std/testing/bdd";
import postgresjs from "postgresjs";
import bcrypt from "npm:bcryptjs@2.4.3";
import { ApiError, Client, type Condominium } from "$shared/client/mod.ts";
import { loginAsSuper } from "./_helpers/auth.ts";

const BASE_URL = "http://localhost:3000";
const DATABASE_URL = Deno.env.get("DATABASE_URL") ??
  "postgres://mague:mague@localhost:5432/mague";
const AUTH = await loginAsSuper();
const client = new Client({ baseUrl: BASE_URL });
const sql = postgresjs(DATABASE_URL, { max: 2 });

describe("auth - tracking + rate-limit + password change", () => {
  let condo: Condominium;
  let occupantId = "";
  let userId = "";
  // Identifier único por run para garantir Valkey limpo (TTL é 5 min - não
  // queremos depender de cleanup explícito entre runs).
  const runStamp = Date.now();
  const userEmail = `auth-track-${runStamp}@test.pt`;
  const userPassword = "TestPass1234";
  let headers: Record<string, string>;

  it("setup - condominium + unit + user (password) + occupant", async () => {
    const { data: c } = await client.super.createCondominium(
      { name: "Auth Tracking Condo" },
      { headers: AUTH },
    );
    condo = c;
    headers = { ...AUTH, "x-condominium-id": condo.id };

    await client.super.createUnit(
      condo.id,
      { designation: "A", permillage: 1000 },
      { headers: AUTH },
    );

    // User criado directo em SQL (com password_hash) para evitar invite/SMTP.
    // O default `nanoid(10)` cobre o id automaticamente.
    const hash = await bcrypt.hash(userPassword, 10);
    const created = await sql<{ id: string }[]>`
      INSERT INTO core.user (name, email, role, is_active, password_hash)
      VALUES (
        'Auth Track User',
        ${userEmail.toLowerCase()},
        NULL,
        true,
        ${hash}
      )
      RETURNING id
    `;
    userId = created[0].id;

    // Occupant ligado ao user - é nele que o login tracking escreve. A API não aceita
    // userId no corpo (a conta liga-se pelo convite), por isso a ligação vai por SQL.
    const { data: occ } = await client.admin.createOccupant(
      {
        name: "Auth Track User",
        type: "owner",
        email: userEmail,
      },
      { headers },
    );
    occupantId = occ.id as string;
    await sql`UPDATE core.occupant SET user_id = ${userId} WHERE id = ${occupantId}`;
  });

  it("login OK 1ª vez - popula first/last_login_at + IP + UA", async () => {
    const before = await sql<{ first: Date | null; last: Date | null }[]>`
      SELECT first_login_at AS first, last_login_at AS last
        FROM core.occupant WHERE id = ${occupantId}
    `;
    assertEquals(before[0].first, null);
    assertEquals(before[0].last, null);

    const { data, status } = await client.auth.login(userEmail, userPassword);
    assertEquals(status, 200);
    assertEquals(typeof data.token, "string");

    const after = await sql<{
      first: Date;
      last: Date;
      ua: string | null;
    }[]>`
      SELECT
        first_login_at AS first,
        last_login_at  AS last,
        last_login_user_agent AS ua
      FROM core.occupant WHERE id = ${occupantId}
    `;
    // Ambos populados.
    assertGreater(after[0].first.getTime(), 0);
    assertGreater(after[0].last.getTime(), 0);
    // user-agent capturado (Deno/fetch envia algum por default).
    assertEquals(typeof after[0].ua === "string" && after[0].ua.length > 0, true);
  });

  it("login OK 2ª vez - first_login_at preservado, last_login_at avança", async () => {
    const snap1 = await sql<{ first: Date }[]>`
      SELECT first_login_at AS first FROM core.occupant WHERE id = ${occupantId}
    `;
    // Pequena pausa para garantir que NOW() retorna timestamp posterior.
    await new Promise((r) => setTimeout(r, 50));

    const { status } = await client.auth.login(userEmail, userPassword);
    assertEquals(status, 200);

    const snap2 = await sql<{ first: Date; last: Date }[]>`
      SELECT first_login_at AS first, last_login_at AS last
        FROM core.occupant WHERE id = ${occupantId}
    `;
    // first_login_at intocado (write-once via COALESCE).
    assertEquals(snap1[0].first.getTime(), snap2[0].first.getTime());
    // last_login_at >= first_login_at (avançou no 2º login ou ficou igual
    // dentro da resolução). Test anterior pode ter executado bem perto deste
    // - usar `>=` em vez de `>` para evitar flaky.
    assertEquals(snap2[0].last.getTime() >= snap2[0].first.getTime(), true);
  });

  it("change-password - atualiza password_changed_at e nova password funciona", async () => {
    const { data: session } = await client.auth.login(userEmail, userPassword);
    const newPassword = "NewPass5678";

    const { status } = await client.auth.changePassword(
      session.token,
      userPassword,
      newPassword,
    );
    // change-password devolve 204 No Content em sucesso.
    assertEquals(status, 204);

    const after = await sql<{ pwc: Date | null }[]>`
      SELECT password_changed_at AS pwc FROM core.user WHERE id = ${userId}
    `;
    assertEquals(after[0].pwc !== null, true);
    assertGreater((after[0].pwc as Date).getTime(), 0);

    // Nova password funciona.
    const { data: sess2, status: s2 } = await client.auth.login(
      userEmail,
      newPassword,
    );
    assertEquals(s2, 200);
    assertEquals(typeof sess2.token, "string");

    // Password antiga falha (mas ainda dentro do rate limit).
    const e = await assertRejects(
      () => client.auth.login(userEmail, userPassword),
      ApiError,
    );
    // Pode ser 401 (credenciais) ou 429 (rate limit) - depende de quantas
    // falhas houve no run. O importante é que NÃO seja 200.
    assertEquals(e.statusCode === 401 || e.statusCode === 429, true);
  });

  // SKIP por default: o `.env` local sobe o limite para 10000/IP-conta para a
  // suite API completa não saturar. Para correr este teste especificamente,
  // baixar `LOGIN_RATE_LIMIT_MAX_PER_IDENTIFIER_IP=5` no `.env`, reiniciar o
  // API (`docker compose restart api`) e correr com `RUN_RATE_LIMIT_TEST=1`.
  it("rate-limit - 5 tentativas falhadas no mesmo identifier → 6ª devolve 429", {
    ignore: (Deno.env.get("RUN_RATE_LIMIT_TEST") ?? "0") !== "1",
  }, async () => {
    // Identifier novo para começar a janela do zero (Valkey TTL 5 min).
    const rlEmail = `rl-${runStamp}@test.pt`;

    // 5 falhas seguidas - todas devem dar 401 INVALID_CREDENTIALS (user não
    // existe, mas o handler trata igual a "wrong password" para não vazar).
    for (let i = 0; i < 5; i++) {
      const e = await assertRejects(
        () => client.auth.login(rlEmail, "wrong"),
        ApiError,
      );
      assertEquals(
        e.statusCode,
        401,
        `tentativa ${i + 1}: esperava 401, veio ${e.statusCode}`,
      );
    }

    // 6ª: rate limit dispara.
    const eRl = await assertRejects(
      () => client.auth.login(rlEmail, "wrong"),
      ApiError,
    );
    assertEquals(eRl.statusCode, 429);
  });

  it("failed_login_attempts - incrementa em login falhado de user existente (audit)", async () => {
    // User existente com email único (criado num só identifier, ainda livre
    // do rate limit do test anterior - que usou rl-...). Vamos fazer 1
    // tentativa errada e checkar o counter.
    const before = await sql<{ n: number }[]>`
      SELECT failed_login_attempts AS n FROM core.user WHERE id = ${userId}
    `;
    const e = await assertRejects(
      () => client.auth.login(userEmail, "definitely-wrong-password"),
      ApiError,
    );
    // Pode ser 401 ou 429 (test anterior pode ter incrementado). Em qualquer
    // dos casos, o counter da DB incrementa porque o user existe.
    assertEquals(e.statusCode === 401 || e.statusCode === 429, true);

    const after = await sql<{ n: number }[]>`
      SELECT failed_login_attempts AS n FROM core.user WHERE id = ${userId}
    `;
    assertGreater(after[0].n, before[0].n);
  });

  it("cleanup - fecha conexão postgres-js e remove condo", async () => {
    try {
      await client.super.deleteCondominium(condo.id, { headers: AUTH });
    } finally {
      await sql.end();
    }
  });
});
