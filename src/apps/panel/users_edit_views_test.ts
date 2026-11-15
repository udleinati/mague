// Render do users/edit.vto: o campo Nome numa conta que abre outro condomínio.

import { assert, assertStringIncludes } from "@std/assert";
import { render } from "./render.ts";

const editCtx = (target: Record<string, unknown> = {}) => ({
  currentCondominiumId: "c1",
  title: "Editar Ana Pinto",
  section: "users",
  target: {
    id: "u1",
    name: "Ana Pinto",
    email: "ana@example.pt",
    isManager: false,
    passwordResetRequiresSuper: false,
    ...target,
  },
  flash: null,
});

const nameInput = (html: string) => html.match(/<input[^>]*id="name"[^>]*>/)?.[0] ?? "";

Deno.test("editar: conta só deste condomínio tem o nome editável", async () => {
  const html = await render("pages/users/edit.vto", editCtx());
  assert(!nameInput(html).includes("disabled"));
});

Deno.test("editar: conta que abre outro condomínio tem o nome bloqueado", async () => {
  // A API recusa (403) e o admin perdia o resto do formulário ao gravar. Um input
  // disabled não é submetido, por isso o toggle de admin continua a gravar.
  const html = await render("pages/users/edit.vto", editCtx({ passwordResetRequiresSuper: true }));
  assertStringIncludes(nameInput(html), "disabled");
  assertStringIncludes(html, "só um super pode alterar o nome");
});
