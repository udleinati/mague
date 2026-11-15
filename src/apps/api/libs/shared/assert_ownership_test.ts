// Testa o builder `assertOwnership` (skip/dispatch): ignora fields vazios e
// chama a assertion certa por par (entity, field). As assertions individuais
// são cobertas por API integration.

import { assertEquals } from "@std/assert";
import { assertOwnership } from "./assert_ownership.ts";

// Mock-postgres mínimo. Cada column é um marker único - quando ops.eq é
// chamado, identificamos qual column foi comparada e qual o valor. Captamos
// SÓ o eq sobre `e.id` (não o eq sobre condominiumId que é fixo).
function makeMockPostgres(knownIds: Set<string>) {
  const calls: Array<{ id: string; tableHint: string }> = [];
  return {
    calls,
    postgres: {
      query: (fn: (db: unknown) => Promise<unknown>) => {
        return fn({
          query: new Proxy({}, {
            get: (_target, table) => ({
              findFirst: (config: {
                where: (e: Record<string, string>, ops: {
                  and: (...xs: unknown[]) => unknown;
                  eq: (col: unknown, v: string) => unknown;
                  isNull: (...xs: unknown[]) => unknown;
                  or: (...xs: unknown[]) => unknown;
                }) => unknown;
              }) => {
                const e = {
                  id: "__ID_COL__",
                  condominiumId: "__CID_COL__",
                  deletedAt: "__DEL_COL__",
                };
                let capturedId = "";
                const ops = {
                  and: (...xs: unknown[]) => xs,
                  eq: (col: unknown, v: string) => {
                    if (col === "__ID_COL__") capturedId = v;
                    return null;
                  },
                  isNull: () => null,
                  or: (...xs: unknown[]) => xs,
                };
                config.where(e, ops);
                calls.push({ id: capturedId, tableHint: String(table) });
                return knownIds.has(capturedId) ? { id: capturedId } : null;
              },
            }),
          }),
        });
      },
    } as unknown as Parameters<typeof assertOwnership>[0],
  };
}

Deno.test("assertOwnership - ignora fields ausentes/null/undefined/empty", async () => {
  const { postgres, calls } = makeMockPostgres(new Set());
  await assertOwnership(
    postgres,
    {
      unitId: undefined,
      supplierId: null,
      accountId: "",
      bankAccountId: undefined,
    } as Record<string, unknown>,
    "cid_x",
    {
      unit: "unitId",
      supplier: "supplierId",
      account: "accountId",
      bankAccount: "bankAccountId",
    },
  );
  // Nenhum field tem valor → zero queries.
  assertEquals(calls.length, 0);
});

Deno.test("assertOwnership - chama assertion certa para cada field presente", async () => {
  const { postgres, calls } = makeMockPostgres(new Set(["u1", "s1", "acc1"]));
  await assertOwnership(
    postgres,
    {
      unitId: "u1",
      supplierId: "s1",
      accountId: "acc1",
    },
    "cid_x",
    {
      unit: "unitId",
      supplier: "supplierId",
      account: "accountId",
    },
  );
  assertEquals(calls.length, 3);
  // Capturamos os ids - confirma que cada um foi enviado para a assertion certa
  // (a `tableHint` reflete a tabela Drizzle que cada assertion usa).
  const byTable = new Map(calls.map((c) => [c.tableHint, c.id]));
  assertEquals(byTable.get("unit"), "u1");
  assertEquals(byTable.get("supplier"), "s1");
  assertEquals(byTable.get("chartOfAccount"), "acc1");
});

Deno.test("assertOwnership - sub-spec parcial só valida os fields no spec", async () => {
  // Body tem 3 fields mas o spec só pede 1 → só valida esse.
  const { postgres, calls } = makeMockPostgres(new Set(["u1"]));
  await assertOwnership(
    postgres,
    {
      unitId: "u1",
      supplierId: "s1",
      accountId: "acc1",
    },
    "cid_x",
    {
      unit: "unitId",
    },
  );
  assertEquals(calls.length, 1);
  assertEquals(calls[0].tableHint, "unit");
});

Deno.test("assertOwnership - id desconhecido → throw (404)", async () => {
  const { postgres } = makeMockPostgres(new Set(["u1"]));
  let threw = false;
  try {
    await assertOwnership(postgres, { unitId: "u_BAD" }, "cid_x", {
      unit: "unitId",
    });
  } catch (e) {
    threw = true;
    // AppError com statusCode 404 (anti-enumeração)
    const err = e as { statusCode?: number; code?: string };
    assertEquals(err.statusCode, 404);
    assertEquals(err.code, "NOT_FOUND");
  }
  assertEquals(threw, true);
});

Deno.test("assertOwnership - body sem o field do spec é tratado como ausente", async () => {
  const { postgres, calls } = makeMockPostgres(new Set());
  // `body` não tem `unitId` de todo. Não deve crashar nem chamar query.
  await assertOwnership(postgres, {} as Record<string, unknown>, "cid_x", {
    unit: "unitId",
  });
  assertEquals(calls.length, 0);
});

Deno.test("assertOwnership - mensagem do 404 concorda com a entidade", async () => {
  // A mensagem chega ao utilizador (flash do painel): "Fração não encontrado" é erro de português.
  const { postgres } = makeMockPostgres(new Set());
  const cases: Array<[Parameters<typeof assertOwnership<{ id: string }>>[3], string]> = [
    [{ unit: "id" }, "Fração não encontrada"],
    [{ bankAccount: "id" }, "Conta bancária não encontrada"],
    [{ account: "id" }, "Conta contabilística não encontrada"],
    [{ supplier: "id" }, "Fornecedor não encontrado"],
    [{ document: "id" }, "Documento não encontrado"],
  ];
  for (const [spec, message] of cases) {
    const err = await assertOwnership(postgres, { id: "x" }, "cid_x", spec).catch((e) => e);
    assertEquals((err as Error).message, message);
  }
});
