// Contrato de `partials/email_log_table.vto` (audit de emails, partilhado por
// fração e ocupante). Renderiza o partial real via renderString - exercita
// table_card + status_badge + formatDateTime, sem BD/API. Protege o invariante
// fail-loud: um email `failed` tem de mostrar o seu `error` (senão o admin não
// sabe que o recibo rebentou). Cobre também o modal: corpo do email (iframe
// srcdoc) + nomes dos anexos + fallback "corpo não guardado".

import { assert, assertStringIncludes } from "@std/assert";
import { renderString } from "./render.ts";

const FRAGMENT = `{{ include "partials/email_log_table.vto" { emails } }}`;

const render = (emails: unknown[]) => renderString(FRAGMENT, { emails });

Deno.test("email_log_table: empty state mostra 'Sem emails enviados'", async () => {
  const html = await render([]);
  assertStringIncludes(html, "Emails enviados");
  assertStringIncludes(html, "Sem emails enviados.");
});

Deno.test("email_log_table: email enviado mostra badge 'Enviado' + datetime PT", async () => {
  const html = await render([{
    id: "1",
    createdAt: "2026-06-15T09:05:00Z",
    subject: "Recibo R2026/00012",
    recipient: "ana@example.pt",
    status: "sent",
    error: null,
    bodyHtml: "<p>O seu recibo</p>",
    attachments: null,
  }]);
  assertStringIncludes(html, "Recibo R2026/00012");
  assertStringIncludes(html, "ana@example.pt");
  assertStringIncludes(html, "Enviado");
  assertStringIncludes(html, "bg-success");
  // formatDateTime: dd/mm/yyyy HH:mm (hora local; só o dia/mês/ano é estável).
  assertStringIncludes(html, "15/06/2026");
  assert(!html.includes("Sem emails enviados."), "com linhas não há empty state");
});

Deno.test("email_log_table: email falhado expõe o error (fail-loud)", async () => {
  const html = await render([{
    id: "2",
    createdAt: "2026-06-15T09:05:00Z",
    subject: "Convocatória - Assembleia ordinária",
    recipient: "bounce@invalid",
    status: "failed",
    error: "550 mailbox unavailable",
    bodyHtml: null,
    attachments: null,
  }]);
  assertStringIncludes(html, "Falhou");
  assertStringIncludes(html, "bg-error");
  assertStringIncludes(html, "550 mailbox unavailable");
});

Deno.test("email_log_table: count reflete o número de linhas", async () => {
  const base = {
    id: "1",
    createdAt: "2026-06-15T09:05:00Z",
    subject: "Recibo",
    recipient: "a@b.pt",
    status: "sent",
    error: null,
    bodyHtml: null,
    attachments: null,
  };
  const html = await render([
    { ...base, id: "1" },
    { ...base, id: "2" },
    { ...base, id: "3" },
  ]);
  assertStringIncludes(html, "· 3");
});

Deno.test("email_log_table: linha clicável abre o modal do email pelo id", async () => {
  const html = await render([{
    id: "42",
    createdAt: "2026-06-15T09:05:00Z",
    subject: "Recibo",
    recipient: "a@b.pt",
    status: "sent",
    error: null,
    bodyHtml: "<p>oi</p>",
    attachments: null,
  }]);
  assertStringIncludes(html, "getElementById('email_modal_42').showModal()");
  assertStringIncludes(html, `id="email_modal_42"`);
});

Deno.test("email_log_table: corpo do email vai escapado no srcdoc do iframe", async () => {
  const html = await render([{
    id: "7",
    createdAt: "2026-06-15T09:05:00Z",
    subject: "Recibo",
    recipient: "a@b.pt",
    status: "sent",
    error: null,
    bodyHtml: `<h1 class="x">Olá & "tudo"</h1>`,
    attachments: null,
  }]);
  // O HTML do email vai num atributo srcdoc - tem de estar HTML-escapado, senão
  // partia o markup do painel (autoescape do Vento trata disto).
  assertStringIncludes(html, "srcdoc=");
  assertStringIncludes(html, "&lt;h1");
  assert(
    !html.includes(`<h1 class="x">Olá`),
    "o corpo do email não pode aparecer cru no DOM do painel",
  );
});

Deno.test("email_log_table: anexos mostram o nome no modal (sem conteúdo)", async () => {
  const html = await render([{
    id: "9",
    createdAt: "2026-06-15T09:05:00Z",
    subject: "Convocatória",
    recipient: "a@b.pt",
    status: "sent",
    error: null,
    bodyHtml: "<p>convocatória</p>",
    attachments: [
      { filename: "convocatoria.pdf", contentType: "application/pdf" },
      { filename: "procuracao.pdf", contentType: "application/pdf" },
    ],
  }]);
  assertStringIncludes(html, "convocatoria.pdf");
  assertStringIncludes(html, "procuracao.pdf");
});

Deno.test("email_log_table: linha antiga sem corpo mostra 'corpo não guardado'", async () => {
  const html = await render([{
    id: "3",
    createdAt: "2026-06-15T09:05:00Z",
    subject: "Recibo antigo",
    recipient: "a@b.pt",
    status: "sent",
    error: null,
    bodyHtml: null,
    attachments: null,
  }]);
  assertStringIncludes(html, "Corpo não guardado");
  assert(!html.includes("srcdoc="), "sem corpo não há iframe");
});
