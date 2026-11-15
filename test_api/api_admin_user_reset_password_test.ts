// POST /v1/admin/condominiums/:cid/users/:userId/reset-password
//
// Reset assistido: o admin gera uma password temporária e entrega-a por fora.
// Existe porque o reset por email falha em silêncio quando o email não chega.
// Cobre:
//   1. Sucesso: 6 chars do alfabeto sem confundíveis; a nova password entra.
//   2. A password anterior deixa de entrar.
//   3. Tokens de invite/reset por abrir ficam invalidados.
//   4. Cross-tenant: user doutro condomínio → 404.
//   5. Conta inativa → 409 USER_INACTIVE (a password nova não abriria nada).
//   6. Alvo super, pedido por admin não-super → 403.
//   7. Conta que também abre outro condomínio (gestor ou condómino), pedido por
//      admin não-super → 403; conta só deste condomínio continua a funcionar.

import { assertEquals, assertMatch, assertNotEquals, assertRejects } from "@std/assert";
import { describe, it } from "@std/testing/bdd";
import postgresjs from "postgresjs";
import { ApiError, Client, type Condominium } from "$shared/client/mod.ts";
import { loginAs, loginAsSuper } from "./_helpers/auth.ts";
import { deleteTestUser, seedInviteToken, seedTestUser, sqlExec } from "./_helpers/db.ts";

const BASE_URL = "http://localhost:3000";
const DATABASE_URL = Deno.env.get("DATABASE_URL") ??
  "postgres://mague:mague@localhost:5432/mague";
const AUTH = await loginAsSuper();
const client = new Client({ baseUrl: BASE_URL });
const sql = postgresjs(DATABASE_URL, { max: 2 });

const ORIGINAL_PASSWORD = "test12345";

async function tryLogin(email: string, password: string): Promise<number> {
  const res = await fetch(`${BASE_URL}/v1/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ identifier: email, password }),
  });
  await res.body?.cancel();
  return res.status;
}

/** Liga o user ao condomínio como manager - é o vínculo mais barato que faz
 *  `membership.inCondo(cid).isRelated` passar. */
async function makeManager(userId: string, cid: string): Promise<void> {
  await sqlExec(
    `INSERT INTO core.manager (condominium_id, user_id) VALUES ('${cid}', '${userId}')
     ON CONFLICT DO NOTHING`,
  );
}

describe("admin user - reset assistido de password", () => {
  let condoA: Condominium;
  let condoB: Condominium;
  let headersA: Record<string, string>;
  const stamp = Date.now();
  const targetEmail = `reset-target-${stamp}@example.pt`;
  const inBEmail = `reset-inb-${stamp}@example.pt`;
  const inactiveEmail = `reset-inactive-${stamp}@example.pt`;
  const superEmail = `reset-super-${stamp}@example.pt`;
  const adminEmail = `reset-admin-${stamp}@example.pt`;
  const managesBEmail = `reset-manages-b-${stamp}@example.pt`;
  const ownsInBEmail = `reset-owns-in-b-${stamp}@example.pt`;
  let targetId = "";
  let inBId = "";
  let inactiveId = "";
  let superId = "";
  let adminId = "";
  let managesBId = "";
  let ownsInBId = "";

  it("setup", async () => {
    const { data: cA } = await client.super.createCondominium(
      { name: `Reset A ${stamp}`, fiscalNumber: "509400301" },
      { headers: AUTH },
    );
    condoA = cA;
    headersA = { ...AUTH, "x-condominium-id": condoA.id };

    const { data: cB } = await client.super.createCondominium(
      { name: `Reset B ${stamp}`, fiscalNumber: "509400302" },
      { headers: AUTH },
    );
    condoB = cB;

    targetId = await seedTestUser({ email: targetEmail, password: ORIGINAL_PASSWORD });
    await makeManager(targetId, condoA.id);

    inBId = await seedTestUser({ email: inBEmail, password: ORIGINAL_PASSWORD });
    await makeManager(inBId, condoB.id);

    inactiveId = await seedTestUser({ email: inactiveEmail, active: false });
    await makeManager(inactiveId, condoA.id);

    superId = await seedTestUser({ email: superEmail, role: "super" });
    await makeManager(superId, condoA.id);

    // Admin não-super de A: é quem tenta (e deve falhar) contra o super.
    adminId = await seedTestUser({ email: adminEmail, password: ORIGINAL_PASSWORD });
    await makeManager(adminId, condoA.id);

    // Contas partilhadas: ligadas a A (por isso visíveis ao admin de A) e também a B.
    managesBId = await seedTestUser({ email: managesBEmail, password: ORIGINAL_PASSWORD });
    await makeManager(managesBId, condoA.id);
    await makeManager(managesBId, condoB.id);

    ownsInBId = await seedTestUser({ email: ownsInBEmail, password: ORIGINAL_PASSWORD });
    await makeManager(ownsInBId, condoA.id);
    await sqlExec(
      `INSERT INTO core.occupant (condominium_id, user_id, name)
       VALUES ('${condoB.id}', '${ownsInBId}', 'Condómina em B')`,
    );
  });

  it("gera password de 6 chars sem caracteres confundíveis", async () => {
    // WHY: o admin dita este código ao telefone. `0/O` e `1/I/L` no alfabeto
    // produziriam códigos que a pessoa não consegue reproduzir, e o suporte
    // voltaria a ser "não consigo entrar" - o problema que isto resolve.
    const { data } = await client.admin.resetUserPassword(targetId, { headers: headersA });
    assertEquals(data.temporaryPassword.length, 6);
    assertMatch(data.temporaryPassword, /^[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{6}$/);
    assertEquals(data.userId, targetId);
    assertEquals(data.email, targetEmail);

    // A password nova entra e a antiga deixa de entrar - as duas metades do
    // contrato. Sem a segunda, um reset que não escrevesse nada passava.
    assertEquals(await tryLogin(targetEmail, data.temporaryPassword), 200);
    assertEquals(await tryLogin(targetEmail, ORIGINAL_PASSWORD), 401);
  });

  it("dois resets seguidos dão passwords diferentes e só a última entra", async () => {
    const { data: first } = await client.admin.resetUserPassword(targetId, { headers: headersA });
    const { data: second } = await client.admin.resetUserPassword(targetId, { headers: headersA });
    assertNotEquals(first.temporaryPassword, second.temporaryPassword);
    assertEquals(await tryLogin(targetEmail, second.temporaryPassword), 200);
    assertEquals(await tryLogin(targetEmail, first.temporaryPassword), 401);
  });

  it("invalida tokens de invite/reset por abrir", async () => {
    // WHY: depois do reset a password é a que o admin ditou. Um link de convite
    // ainda válido no email seria um segundo caminho de entrada que o admin
    // julga fechado.
    await seedInviteToken({ token: `tok-inv-${stamp}`, userId: targetId, purpose: "invite" });
    await seedInviteToken({ token: `tok-res-${stamp}`, userId: targetId, purpose: "reset" });

    const before = await sql<{ open: number }[]>`
      SELECT COUNT(*)::int AS open FROM core.invite_token
       WHERE user_id = ${targetId} AND used_at IS NULL
    `;
    assertEquals(before[0].open, 2);

    await client.admin.resetUserPassword(targetId, { headers: headersA });

    const after = await sql<{ open: number }[]>`
      SELECT COUNT(*)::int AS open FROM core.invite_token
       WHERE user_id = ${targetId} AND used_at IS NULL
    `;
    assertEquals(after[0].open, 0);
  });

  it("user doutro condomínio -> 404 (não confirma sequer que existe)", async () => {
    const e = await assertRejects(
      () => client.admin.resetUserPassword(inBId, { headers: headersA }),
      ApiError,
    );
    assertEquals(e.statusCode, 404);
    // A password de B ficou intacta - o 404 não é cosmético.
    assertEquals(await tryLogin(inBEmail, ORIGINAL_PASSWORD), 200);
  });

  it("conta inativa -> 409 em vez de um código que não abriria nada", async () => {
    // WHY: login e forgot-password filtram por is_active=true (ADR 0020). Sem
    // este guard o admin recebia um código, ditava-o, e a pessoa continuava
    // fora - exactamente o sintoma que este endpoint existe para acabar.
    const e = await assertRejects(
      () => client.admin.resetUserPassword(inactiveId, { headers: headersA }),
      ApiError,
    );
    assertEquals(e.statusCode, 409);
  });

  it("admin não-super não repõe a password de um super", async () => {
    // WHY: um super com fração/manager no condomínio passa o teste de vínculo.
    // Sem este guard, qualquer admin de condomínio tomava a conta que gere
    // todos os condomínios.
    const adminAuth = await loginAs(adminEmail, ORIGINAL_PASSWORD);
    const e = await assertRejects(
      () =>
        client.admin.resetUserPassword(superId, {
          headers: { ...adminAuth, "x-condominium-id": condoA.id },
        }),
      ApiError,
    );
    assertEquals(e.statusCode, 403);
  });

  it("admin não-super repõe a password de quem só pertence ao seu condomínio", async () => {
    // Controlo dos guards abaixo: o caso para que o reset existe continua a funcionar.
    const adminAuth = await loginAs(adminEmail, ORIGINAL_PASSWORD);
    const { data } = await client.admin.resetUserPassword(targetId, {
      headers: { ...adminAuth, "x-condominium-id": condoA.id },
    });
    assertEquals(await tryLogin(targetEmail, data.temporaryPassword), 200);
  });

  it("admin não-super não repõe a password de uma conta que também gere outro condomínio", async () => {
    // WHY: a password é da conta. O admin de A entrava com o código que gerou e
    // ficava a administrar B, que não gere.
    const adminAuth = await loginAs(adminEmail, ORIGINAL_PASSWORD);
    const e = await assertRejects(
      () =>
        client.admin.resetUserPassword(managesBId, {
          headers: { ...adminAuth, "x-condominium-id": condoA.id },
        }),
      ApiError,
    );
    assertEquals(e.statusCode, 403);
    assertEquals(await tryLogin(managesBEmail, ORIGINAL_PASSWORD), 200);
  });

  it("GET do utilizador diz ao painel quando só um super pode repor", async () => {
    // Sem isto o painel mostrava o botão, o admin escrevia CONFIRMO e recebia o 403.
    const adminHeaders = {
      ...(await loginAs(adminEmail, ORIGINAL_PASSWORD)),
      "x-condominium-id": condoA.id,
    };
    const flag = async (userId: string, headers: Record<string, string>) =>
      (await client.admin.getUser(userId, { headers })).data.passwordResetRequiresSuper;
    assertEquals(await flag(targetId, adminHeaders), false);
    assertEquals(await flag(managesBId, adminHeaders), true);
    assertEquals(await flag(ownsInBId, adminHeaders), true);
    assertEquals(await flag(superId, adminHeaders), true);
    assertEquals(await flag(managesBId, headersA), false);
  });

  it("admin não-super não repõe a password de uma conta que é condómina noutro condomínio", async () => {
    // WHY: mesmo sem gerir B, a conta abre o portal da fração em B (quotas, IBAN,
    // documentos). O admin de A não tem autoridade sobre esse acesso.
    const adminAuth = await loginAs(adminEmail, ORIGINAL_PASSWORD);
    const e = await assertRejects(
      () =>
        client.admin.resetUserPassword(ownsInBId, {
          headers: { ...adminAuth, "x-condominium-id": condoA.id },
        }),
      ApiError,
    );
    assertEquals(e.statusCode, 403);
    assertEquals(await tryLogin(ownsInBEmail, ORIGINAL_PASSWORD), 200);
  });

  it("teardown", async () => {
    await sqlExec(`DELETE FROM core.occupant WHERE user_id = '${ownsInBId}'`);
    for (const id of [targetId, inBId, inactiveId, superId, adminId, managesBId, ownsInBId]) {
      await sqlExec(`DELETE FROM core.manager WHERE user_id = '${id}'`);
      await deleteTestUser(id);
    }
    await sql.end();
  });
});
