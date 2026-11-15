// Regras de encaminhamento dos emails de interação:
// notifica-se sempre o lado OPOSTO ao autor, e nunca se envia por email o que
// o portal esconde. Cada teste falha se a regra mudar - não é só cobertura.

import { assertEquals } from "@std/assert";
import { decideActivityRecipient } from "./_notify.ts";

const reporter = { occupantId: "occ1", name: "Maria Silva", email: "maria@example.pt" };

Deno.test("autor fração → notifica a caixa do condomínio (nunca o próprio)", () => {
  const out = decideActivityRecipient({
    authorSide: "unit",
    visibility: "admin_unit",
    condominiumEmail: "geral@condo.pt",
    reporter,
  });
  assertEquals(out, { recipient: { side: "condominium", email: "geral@condo.pt", name: null } });
});

Deno.test("autor fração sem email do condomínio → skip (operação não falha)", () => {
  const out = decideActivityRecipient({
    authorSide: "unit",
    visibility: "admin_unit",
    condominiumEmail: "   ",
    reporter,
  });
  assertEquals("skip" in out, true);
});

Deno.test("autor administração → notifica o reporter", () => {
  const out = decideActivityRecipient({
    authorSide: "admin",
    visibility: "admin_unit",
    condominiumEmail: "geral@condo.pt",
    reporter,
  });
  assertEquals(out, {
    recipient: {
      side: "reporter",
      email: "maria@example.pt",
      name: "Maria Silva",
      occupantId: "occ1",
    },
  });
});

Deno.test("admin_only corta o email ao reporter (o portal esconde a ocorrência)", () => {
  const out = decideActivityRecipient({
    authorSide: "admin",
    visibility: "admin_only",
    condominiumEmail: "geral@condo.pt",
    reporter,
  });
  assertEquals("skip" in out, true);
});

Deno.test("ocorrência criada pelo admin (sem reporter) não notifica a fração", () => {
  const out = decideActivityRecipient({
    authorSide: "admin",
    visibility: "admin_unit",
    condominiumEmail: "geral@condo.pt",
    reporter: null,
  });
  assertEquals("skip" in out, true);
});

Deno.test("reporter sem email → skip, sem cair para outros ocupantes", () => {
  const out = decideActivityRecipient({
    authorSide: "admin",
    visibility: "admin_unit",
    condominiumEmail: "geral@condo.pt",
    reporter: { ...reporter, email: null },
  });
  assertEquals("skip" in out, true);
});

Deno.test("ocorrência public do admin continua a notificar o reporter", () => {
  const out = decideActivityRecipient({
    authorSide: "admin",
    visibility: "public",
    condominiumEmail: "geral@condo.pt",
    reporter,
  });
  assertEquals("skip" in out, false);
});
