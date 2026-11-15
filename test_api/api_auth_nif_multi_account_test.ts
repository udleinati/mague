// Login e "esqueci-me da password" por NIF quando o NIF está em mais de uma conta.
//
// O NIF vive no ocupante de cada condomínio; a conta é por email. A mesma pessoa com
// emails diferentes em A e em B tem duas contas com o mesmo NIF. O login escolhia
// uma ao acaso e dizia "credenciais inválidas" com a password certa da outra; o
// reset ia só para uma delas.
//   1. Cada password entra na sua conta.
//   2. Password que não é de nenhuma → 401.
//   3. Reset por NIF chega ao email de cada conta.

import { assertEquals } from "@std/assert";
import { describe, it } from "@std/testing/bdd";
import { Client, type Condominium } from "$shared/client/mod.ts";
import { loginAsSuper } from "./_helpers/auth.ts";
import { deleteTestUser, seedTestUser, sqlExec } from "./_helpers/db.ts";
import { flushMailpit, waitForEmail } from "./_helpers/mailpit.ts";

const BASE_URL = "http://localhost:3000";
const AUTH = await loginAsSuper();
const client = new Client({ baseUrl: BASE_URL });

async function loginByNif(nif: string, password: string) {
  const res = await fetch(`${BASE_URL}/v1/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ identifier: nif, password }),
  });
  const body = await res.json().catch(() => ({}));
  return { status: res.status, userId: body?.data?.user?.id as string | undefined };
}

describe("auth - NIF em duas contas (um email por condomínio)", () => {
  const stamp = Date.now();
  // NIF único por run, para não colidir com outros testes.
  const nif = `2${String(stamp).slice(-8)}`;
  const emailA = `nif-multi-a-${stamp}@example.pt`;
  const emailB = `nif-multi-b-${stamp}@example.pt`;
  let condoA: Condominium;
  let condoB: Condominium;
  let userA = "";
  let userB = "";

  it("setup: Maria com uma conta em A e outra em B, mesmo NIF", async () => {
    condoA = (await client.super.createCondominium(
      { name: `NIF A ${stamp}`, fiscalNumber: "509400601" },
      { headers: AUTH },
    )).data;
    condoB = (await client.super.createCondominium(
      { name: `NIF B ${stamp}`, fiscalNumber: "509400602" },
      { headers: AUTH },
    )).data;
    userA = await seedTestUser({ email: emailA, password: "passA12345" });
    userB = await seedTestUser({ email: emailB, password: "passB12345" });
    await sqlExec(
      `INSERT INTO core.occupant (condominium_id, user_id, name, nif, email) VALUES
         ('${condoA.id}', '${userA}', 'Maria', '${nif}', '${emailA}'),
         ('${condoB.id}', '${userB}', 'Maria', '${nif}', '${emailB}')`,
    );
  });

  it("cada password entra na sua conta, sempre", async () => {
    // WHY: com a password certa, a Maria recebia "credenciais inválidas" metade das vezes.
    // Duas vezes seguidas cada uma: o login atualiza a linha do ocupante e muda a ordem
    // em que o NIF devolve as contas, por isso uma só tentativa passava por sorte.
    for (const [password, userId] of [["passA12345", userA], ["passB12345", userB]]) {
      for (const attempt of [1, 2]) {
        assertEquals(
          await loginByNif(nif, password),
          { status: 200, userId },
          `${password} #${attempt}`,
        );
      }
    }
  });

  it("password que não é de nenhuma das contas → 401", async () => {
    assertEquals((await loginByNif(nif, "errada12345")).status, 401);
  });

  it("reset por NIF chega ao email de cada conta", async () => {
    // WHY: o link ia só para uma conta; a Maria podia estar a tentar entrar na outra.
    // Cada link vai para o email da própria conta, por isso ninguém recebe o de outro.
    await flushMailpit();
    const res = await fetch(`${BASE_URL}/v1/auth/forgot-password`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ identifier: nif }),
    });
    await res.body?.cancel();
    assertEquals(res.status, 204);
    await waitForEmail({ to: emailA });
    await waitForEmail({ to: emailB });
  });

  it("teardown", async () => {
    await sqlExec(
      `DELETE FROM core.occupant WHERE condominium_id IN ('${condoA.id}', '${condoB.id}')`,
    );
    await deleteTestUser(userA);
    await deleteTestUser(userB);
  });
});
