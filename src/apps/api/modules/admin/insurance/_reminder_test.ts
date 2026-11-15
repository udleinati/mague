import { assertEquals, assertRejects } from "@std/assert";
import { AppError } from "$api/libs/error/app_error.ts";
import type { Postgres } from "$api/libs/postgres/postgres.ts";
import { insuranceReminderSubject, resolveReminderRecipients } from "./_reminder.ts";

// Fake Postgres - devolve respostas pré-canned por ordem de chamada.
// `resolveReminderRecipients` faz no máximo 2 queries:
//   1. unit_occupant + nested (occupant, unit, condominium) → array
//   2. unit (designation) - só quando eligible.length === 0 → object
// O .query() ignora a lambda - confiamos nas asserções a montante.
function fakePostgres(responses: unknown[]): Postgres {
  let i = 0;
  return {
    // deno-lint-ignore require-await no-explicit-any
    query: async (_fn: any) => responses[i++],
  } as unknown as Postgres;
}

// Tracer bullet: 1 occupant válido com email → devolve EligibleRecipient[1].
Deno.test("1 occupant válido → 1 EligibleRecipient", async () => {
  const rows = [{
    occupant: {
      id: "occ_1",
      name: "Ana",
      email: "ana@test.pt",
      deletedAt: null,
      condominiumId: "c1",
    },
    unit: {
      condominiumId: "c1",
      designation: "1ºA",
      identifier: "Bloco A 1º Esq",
      condominium: { name: "Condo X", designationType: "building" },
    },
  }];
  const r = await resolveReminderRecipients(fakePostgres([rows]), {
    condominiumId: "c1",
    unitId: "u1",
  });
  assertEquals(r.length, 1);
  assertEquals(r[0].occupantId, "occ_1");
  assertEquals(r[0].name, "Ana");
  assertEquals(r[0].email, "ana@test.pt");
  assertEquals(r[0].condoName, "Condo X");
  // unitLabel formato canónico - "designation - identifier".
  assertEquals(r[0].unitLabel, "1ºA - Bloco A 1º Esq");
});

// occupant soft-deleted → filtrado fora. Defesa contra ler comunicação
// para occupants que já não estão ativos.
Deno.test("occupant.deletedAt !== null → filtrado fora", async () => {
  const rows = [{
    occupant: {
      id: "occ_1",
      name: "Ex",
      email: "ex@test.pt",
      deletedAt: "2024-01-01T00:00:00Z",
      condominiumId: "c1",
    },
    unit: {
      condominiumId: "c1",
      designation: "X",
      identifier: null,
      condominium: { name: "C", designationType: "building" },
    },
  }];
  // 2ª query (unit designation) é feita quando eligible está vazio.
  const fallbackUnit = { designation: "X" };
  await assertRejects(
    () =>
      resolveReminderRecipients(fakePostgres([rows, fallbackUnit]), {
        condominiumId: "c1",
        unitId: "u1",
      }),
    AppError,
  );
});

// email null → filtrado fora.
Deno.test("email null → filtrado fora", async () => {
  const rows = [{
    occupant: { id: "occ_1", name: "A", email: null, deletedAt: null, condominiumId: "c1" },
    unit: {
      condominiumId: "c1",
      designation: "X",
      identifier: null,
      condominium: { name: "C", designationType: "building" },
    },
  }];
  await assertRejects(
    () =>
      resolveReminderRecipients(fakePostgres([rows, { designation: "X" }]), {
        condominiumId: "c1",
        unitId: "u1",
      }),
    AppError,
  );
});

// email só-com-whitespace → filtrado fora (treat as empty).
Deno.test("email com só whitespace → filtrado fora", async () => {
  const rows = [{
    occupant: { id: "occ_1", name: "A", email: "   ", deletedAt: null, condominiumId: "c1" },
    unit: {
      condominiumId: "c1",
      designation: "X",
      identifier: null,
      condominium: { name: "C", designationType: "building" },
    },
  }];
  await assertRejects(
    () =>
      resolveReminderRecipients(fakePostgres([rows, { designation: "X" }]), {
        condominiumId: "c1",
        unitId: "u1",
      }),
    AppError,
  );
});

// Mistura: 1 válido + 1 sem email → devolve só o válido (não throw).
Deno.test("mistura válidos + filtrados → devolve só os válidos", async () => {
  const rows = [
    {
      occupant: { id: "ok", name: "Ok", email: "ok@x.pt", deletedAt: null, condominiumId: "c1" },
      unit: {
        condominiumId: "c1",
        designation: "1A",
        identifier: null,
        condominium: { name: "C", designationType: "building" },
      },
    },
    {
      occupant: { id: "no", name: "No", email: "", deletedAt: null, condominiumId: "c1" },
      unit: {
        condominiumId: "c1",
        designation: "1A",
        identifier: null,
        condominium: { name: "C", designationType: "building" },
      },
    },
  ];
  const r = await resolveReminderRecipients(fakePostgres([rows]), {
    condominiumId: "c1",
    unitId: "u1",
  });
  assertEquals(r.length, 1);
  assertEquals(r[0].occupantId, "ok");
});

// Ligação cruzada (ocupante de B numa fração de A, ou fração de outro condomínio):
// o email sairia em nome deste condomínio para quem não pertence a ele.
Deno.test("fração ou ocupante de outro condomínio → filtrado fora", async () => {
  const row = (occupantCid: string, unitCid: string, id: string) => ({
    occupant: { id, name: id, email: `${id}@x.pt`, deletedAt: null, condominiumId: occupantCid },
    unit: {
      condominiumId: unitCid,
      designation: "1A",
      identifier: null,
      condominium: { name: "C", designationType: "building" },
    },
  });
  const r = await resolveReminderRecipients(
    fakePostgres([[row("c1", "c1", "ok"), row("c2", "c1", "occB"), row("c1", "c2", "unitB")]]),
    { condominiumId: "c1", unitId: "u1" },
  );
  assertEquals(r.map((x) => x.occupantId), ["ok"]);
});

// Sem identifier → unitLabel = só designation.
Deno.test("unit sem identifier → label = só designation", async () => {
  const rows = [{
    occupant: { id: "occ_1", name: "A", email: "a@x.pt", deletedAt: null, condominiumId: "c1" },
    unit: {
      condominiumId: "c1",
      designation: "1ºA",
      identifier: null,
      condominium: { name: "C", designationType: "building" },
    },
  }];
  const r = await resolveReminderRecipients(fakePostgres([rows]), {
    condominiumId: "c1",
    unitId: "u1",
  });
  assertEquals(r[0].unitLabel, "1ºA");
});

// 0 elegíveis → AppError MISSING_EMAIL com 422 + mensagem que inclui designation.
Deno.test("zero elegíveis → MISSING_EMAIL com designation no message", async () => {
  const rows: unknown[] = []; // sem occupants
  const fallbackUnit = { designation: "Bloco A 2ºE" };
  const err = await assertRejects(
    () =>
      resolveReminderRecipients(fakePostgres([rows, fallbackUnit]), {
        condominiumId: "c1",
        unitId: "u_x",
      }),
    AppError,
  );
  assertEquals(err.statusCode, 422);
  assertEquals(err.code, "MISSING_EMAIL");
  // Mensagem ao admin tem que incluir a designation para ser actionable.
  assertEquals(err.message.includes("Bloco A 2ºE"), true);
});

// Fallback: se o unit lookup também falhar, usa unitId como fallback no message.
Deno.test("zero elegíveis + unit lookup vazio → fallback usa unitId", async () => {
  const err = await assertRejects(
    () =>
      resolveReminderRecipients(fakePostgres([[], null]), {
        condominiumId: "c1",
        unitId: "u_42",
      }),
    AppError,
  );
  assertEquals(err.message.includes("u_42"), true);
});

// designationType passa por sem alteração (typing safety: any string passa).
Deno.test("condoDesignationType cast preservado", async () => {
  const rows = [{
    occupant: { id: "o", name: "n", email: "e@x.pt", deletedAt: null, condominiumId: "c1" },
    unit: {
      condominiumId: "c1",
      designation: "X",
      identifier: null,
      condominium: { name: "C", designationType: "condominium" },
    },
  }];
  const r = await resolveReminderRecipients(fakePostgres([rows]), {
    condominiumId: "c1",
    unitId: "u",
  });
  assertEquals(r[0].condoDesignationType, "condominium");
});

// Envio e pré-visualização usam a mesma função: o assunto que o admin vê no
// modal é o que o condómino recebe, e segue o mesmo trigger do corpo.
Deno.test("assunto: seguro em falta vs pedido do comprovativo da renovação", () => {
  const args = { condoName: "Edifício X", unitLabel: "A" };
  assertEquals(
    insuranceReminderSubject("individual", args),
    "Seguro em falta - Edifício X, fração A",
  );
  assertEquals(insuranceReminderSubject("bulk", args), "Seguro em falta - Edifício X, fração A");
  assertEquals(
    insuranceReminderSubject("renewal_evidence", args),
    "Renovação de seguro - envie o comprovativo (Edifício X, fração A)",
  );
});
