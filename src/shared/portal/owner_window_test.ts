import { assertEquals } from "@std/assert";
import {
  filterChargesByWindow,
  filterSettlementsByWindow,
  isInOwnerWindow,
  type NestedOccupantUO,
  type OwnerWindow,
  resolveOwnerWindow,
} from "./owner_window.ts";

function uo(
  occupantId: string,
  occupantName: string,
  startDate: string,
  endDate: string | null = null,
  userId: string | null = null,
  relationshipType = "owner",
): NestedOccupantUO {
  return {
    relationshipType,
    startDate,
    endDate,
    occupant: { id: occupantId, name: occupantName, userId },
  };
}

Deno.test("resolveOwnerWindow - sem owners devolve null", () => {
  assertEquals(resolveOwnerWindow([], null), null);
  assertEquals(resolveOwnerWindow([uo("o1", "X", "2020-01-01", null, null, "tenant")], null), null);
});

Deno.test("resolveOwnerWindow - occupant logged usa a sua associação owner", () => {
  const window_ = resolveOwnerWindow(
    [
      uo("o1", "Alice", "2020-01-01", "2022-12-31", "user_alice"),
      uo("o2", "Bob", "2023-01-01", null, "user_bob"),
    ],
    { id: "user_alice", role: "occupant" },
  );
  assertEquals(window_, {
    startDate: "2020-01-01",
    endDate: "2022-12-31",
    occupantName: "Alice",
    isImpersonatedView: false,
  });
});

Deno.test("resolveOwnerWindow - admin sem associação cai no owner ativo mais recente", () => {
  const window_ = resolveOwnerWindow(
    [
      uo("o1", "Alice", "2020-01-01", "2022-12-31", "user_alice"),
      uo("o2", "Bob", "2023-01-01", null, "user_bob"),
      uo("o3", "Carlos", "2024-06-01", null, "user_carlos"),
    ],
    { id: "user_admin", role: "admin" },
  );
  assertEquals(window_?.occupantName, "Carlos");
  assertEquals(window_?.startDate, "2024-06-01");
  assertEquals(window_?.endDate, null);
  assertEquals(window_?.isImpersonatedView, true);
});

Deno.test("resolveOwnerWindow - admin que TAMBÉM é owner usa a sua própria janela", () => {
  // Regressão: um admin/super pode ser condómino de uma fração. Antes, o
  // ramo da janela própria só disparava para role==="occupant", pelo que
  // o admin caía no "owner ativo mais recente" - se outro condómino tivesse
  // entrado depois, recibos antigos do admin ficavam "fora do período".
  const window_ = resolveOwnerWindow(
    [
      uo("o1", "Admin Proprietário", "2025-01-01", null, "user_admin_owner"),
      uo("o2", "Owner Novo", "2026-05-20", null, "user_new_owner"),
    ],
    { id: "user_admin_owner", role: "admin" },
  );
  assertEquals(window_, {
    startDate: "2025-01-01",
    endDate: null,
    occupantName: "Admin Proprietário",
    isImpersonatedView: false,
  });
});

Deno.test("resolveOwnerWindow - resident logado usa a sua própria janela", () => {
  // Um residente que abre o portal vê o SEU período de residência, não o
  // do proprietário. Cobre o caso de o residente receber comunicações
  // (recibos, avisos) de um período anterior ao owner atual.
  const window_ = resolveOwnerWindow(
    [
      uo("o1", "Owner Atual", "2026-05-20", null, "user_owner"),
      uo("r1", "Residente", "2025-03-01", null, "user_resident", "resident"),
    ],
    { id: "user_resident", role: "occupant" },
  );
  assertEquals(window_, {
    startDate: "2025-03-01",
    endDate: null,
    occupantName: "Residente",
    isImpersonatedView: false,
  });
});

Deno.test("resolveOwnerWindow - tenant logado NÃO usa janela própria (cai no owner)", () => {
  // Inquilino fica de fora da janela própria - mesmo tratamento das
  // comunicações financeiras. Cai no fallback (owner ativo mais recente).
  const window_ = resolveOwnerWindow(
    [
      uo("o1", "Owner", "2024-01-01", null, "user_owner"),
      uo("t1", "Inquilino", "2025-06-01", null, "user_tenant", "tenant"),
    ],
    { id: "user_tenant", role: "occupant" },
  );
  assertEquals(window_?.occupantName, "Owner");
  assertEquals(window_?.startDate, "2024-01-01");
  assertEquals(window_?.isImpersonatedView, true);
});

Deno.test("resolveOwnerWindow - unit só com resident: resident logado tem janela própria", () => {
  // Sem owners de todo: o residente logado obtém a sua janela (não null, que
  // seria "sem filtro"). Admin a impersonar cai em null.
  const occupants = [uo("r1", "Residente", "2025-03-01", null, "user_resident", "resident")];
  const asResident = resolveOwnerWindow(occupants, { id: "user_resident", role: "occupant" });
  assertEquals(asResident?.occupantName, "Residente");
  assertEquals(asResident?.startDate, "2025-03-01");
  const asAdmin = resolveOwnerWindow(occupants, { id: "user_admin", role: "admin" });
  assertEquals(asAdmin, null);
});

Deno.test("resolveOwnerWindow - sem owner ativo cai no último que terminou", () => {
  const window_ = resolveOwnerWindow(
    [
      uo("o1", "Alice", "2020-01-01", "2022-12-31"),
      uo("o2", "Bob", "2023-01-01", "2024-05-30"),
    ],
    { id: "user_admin", role: "admin" },
  );
  assertEquals(window_?.occupantName, "Bob");
  assertEquals(window_?.endDate, "2024-05-30");
  assertEquals(window_?.isImpersonatedView, true);
});

Deno.test("resolveOwnerWindow - occupant não-owner cai em fallback de admin", () => {
  // O user é occupant mas não tem relação owner desta unit (ex: tenant).
  const window_ = resolveOwnerWindow(
    [
      uo("o1", "Alice", "2020-01-01", null, "user_alice"),
      uo("oT", "Tenant", "2024-01-01", null, "user_tenant", "tenant"),
    ],
    { id: "user_tenant", role: "occupant" },
  );
  assertEquals(window_?.occupantName, "Alice");
  assertEquals(window_?.isImpersonatedView, true);
});

Deno.test("isInOwnerWindow - sem janela devolve true", () => {
  assertEquals(isInOwnerWindow("2024-05-15", null), true);
});

Deno.test("isInOwnerWindow - sem data devolve false", () => {
  const w: OwnerWindow = {
    startDate: "2024-01-01",
    endDate: null,
    occupantName: "X",
    isImpersonatedView: false,
  };
  assertEquals(isInOwnerWindow(null, w), false);
  assertEquals(isInOwnerWindow(undefined, w), false);
});

Deno.test("isInOwnerWindow - dentro/fora dos limites", () => {
  const w: OwnerWindow = {
    startDate: "2024-01-01",
    endDate: "2024-12-31",
    occupantName: "X",
    isImpersonatedView: false,
  };
  assertEquals(isInOwnerWindow("2023-12-31", w), false); // antes
  assertEquals(isInOwnerWindow("2024-01-01", w), true); // borda inclusive
  assertEquals(isInOwnerWindow("2024-06-15", w), true);
  assertEquals(isInOwnerWindow("2024-12-31", w), true); // borda inclusive
  assertEquals(isInOwnerWindow("2025-01-01", w), false); // depois
});

Deno.test("isInOwnerWindow - sem endDate aceita futuro", () => {
  const w: OwnerWindow = {
    startDate: "2024-01-01",
    endDate: null,
    occupantName: "X",
    isImpersonatedView: false,
  };
  assertEquals(isInOwnerWindow("2099-12-31", w), true);
});

Deno.test("filterChargesByWindow - prefere competencePeriod sobre issueDate", () => {
  const w: OwnerWindow = {
    startDate: "2024-06-01",
    endDate: null,
    occupantName: "X",
    isImpersonatedView: false,
  };
  const charges = [
    { id: "c1", competencePeriod: "2024-05-01", issueDate: "2024-07-01" }, // CP fora
    { id: "c2", competencePeriod: "2024-07-01", issueDate: "2024-05-01" }, // CP dentro
    { id: "c3", competencePeriod: null, issueDate: "2024-08-01" }, // fallback issue, dentro
    { id: "c4", competencePeriod: null, issueDate: "2024-04-01" }, // fallback issue, fora
  ];
  const filtered = filterChargesByWindow(charges, w);
  assertEquals(filtered.map((c) => c.id), ["c2", "c3"]);
});

Deno.test("filterSettlementsByWindow - tocar unit diretamente OU via charge", () => {
  const w: OwnerWindow = {
    startDate: "2024-01-01",
    endDate: null,
    occupantName: "X",
    isImpersonatedView: false,
  };
  const chargeIds = new Set(["ch_a", "ch_b"]);
  const settlements = [
    {
      id: "s1",
      unitId: "u1",
      debitChargeId: null,
      creditChargeId: null,
      settlementDate: "2024-06-01",
      bankTransaction: null,
    },
    {
      id: "s2",
      unitId: "u2",
      debitChargeId: "ch_a",
      creditChargeId: null,
      settlementDate: "2024-06-01",
      bankTransaction: null,
    },
    {
      id: "s3",
      unitId: "u2",
      debitChargeId: "ch_OUTRA",
      creditChargeId: null,
      settlementDate: "2024-06-01",
      bankTransaction: null,
    },
    {
      id: "s4",
      unitId: "u1",
      debitChargeId: null,
      creditChargeId: null,
      settlementDate: "2023-12-01",
      bankTransaction: null,
    }, // fora
  ];
  const filtered = filterSettlementsByWindow(settlements, chargeIds, "u1", w);
  assertEquals(filtered.map((s) => s.id), ["s1", "s2"]);
});

Deno.test("filterSettlementsByWindow - prefere bankTransaction.transactionDate sobre settlementDate", () => {
  const w: OwnerWindow = {
    startDate: "2024-06-01",
    endDate: "2024-12-31",
    occupantName: "X",
    isImpersonatedView: false,
  };
  const settlements = [
    {
      id: "s1",
      unitId: "u1",
      debitChargeId: null,
      creditChargeId: null,
      settlementDate: "2024-08-01", // dentro
      bankTransaction: { transactionDate: "2025-01-01" }, // FORA - usa esta
    },
    {
      id: "s2",
      unitId: "u1",
      debitChargeId: null,
      creditChargeId: null,
      settlementDate: "2025-01-01", // fora
      bankTransaction: { transactionDate: "2024-08-01" }, // DENTRO - usa esta
    },
  ];
  const filtered = filterSettlementsByWindow(settlements, new Set(), "u1", w);
  assertEquals(filtered.map((s) => s.id), ["s2"]);
});
