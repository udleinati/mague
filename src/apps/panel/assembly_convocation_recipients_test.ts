// Contrato de `pages/assembly/_convocation_recipients.vto`: cada destinatário tem um
// "Ver" que aponta a rota de pré-visualização do email (occupant/unit) e um "Enviar".
// Renderiza o partial real via renderString (sem BD/API). Protege a intenção (Rule 9):
//   - o "Ver" existe por (pessoa × fração) com a URL certa (é a parte mais sujeita a typo);
//   - o "Ver" é read-only: aparece mesmo sem email, enquanto o "Enviar" desativa.

import { assert, assertStringIncludes } from "@std/assert";
import { renderString } from "./render.ts";

const FRAGMENT = `{{ include "pages/assembly/_convocation_recipients.vto" {
  target, convocationRecipients, canSend, currentCondominiumId, toast: null
} }}`;

function recipient(p: Record<string, unknown> = {}) {
  return {
    occupantId: "occ1",
    unitId: "unit1",
    name: "Maria Silva",
    unitLabel: "AT - 5C",
    email: "maria@test.pt",
    hasEmail: true,
    lastSentAt: null,
    inCooldown: false,
    cooldownUntil: null,
    ...p,
  };
}

const render = (recipients: unknown[], canSend = true) =>
  renderString(FRAGMENT, {
    target: { id: "asm1" },
    convocationRecipients: recipients,
    canSend,
    currentCondominiumId: "cid1",
  });

Deno.test("_convocation_recipients: cada linha tem 'Ver' a apontar a rota de preview", async () => {
  const html = await render([recipient()]);
  assertStringIncludes(html, "openConvocationPreview");
  assertStringIncludes(
    html,
    "/admin/c/cid1/assembly/asm1/convocation/preview/occ1/unit1",
  );
});

Deno.test("_convocation_recipients: 'Ver' aparece mesmo sem email; 'Enviar' desativa", async () => {
  const html = await render([recipient({ hasEmail: false, email: null })]);
  // Read-only: o preview não depende de o destinatário ter email registado.
  assertStringIncludes(html, "openConvocationPreview");
  // Fail-loud do envio: sem email o botão "Enviar" fica disabled.
  assert(html.includes("disabled"), "o botão Enviar fica disabled sem email");
});
