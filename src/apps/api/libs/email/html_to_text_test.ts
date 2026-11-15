import { assertEquals } from "@std/assert";
import { htmlToText } from "./html_to_text.ts";
import { inviteEmailHtml, receiptIssuedEmailHtml } from "./templates.ts";

Deno.test("htmlToText: parágrafo simples", () => {
  assertEquals(htmlToText("<p>Olá mundo</p>"), "Olá mundo");
});

Deno.test("htmlToText: tags inline removidas, conteúdo preservado", () => {
  assertEquals(
    htmlToText("<p>Caro <strong>João</strong>,</p>"),
    "Caro João,",
  );
});

Deno.test("htmlToText: link com label diferente do href → 'label (URL)'", () => {
  assertEquals(
    htmlToText('<a href="https://x.com/abc">clica aqui</a>'),
    "clica aqui (https://x.com/abc)",
  );
});

Deno.test("htmlToText: link com label igual ao href → só URL", () => {
  assertEquals(
    htmlToText('<a href="https://x.com">https://x.com</a>'),
    "https://x.com",
  );
});

Deno.test("htmlToText: link multi-linha com style", () => {
  const html = `<a href="https://app.mague.pt/accept?token=abc"
       style="display:inline-block;padding:13px 36px;">
      Definir password
    </a>`;
  assertEquals(
    htmlToText(html),
    "Definir password (https://app.mague.pt/accept?token=abc)",
  );
});

Deno.test("htmlToText: <br> vira newline", () => {
  assertEquals(htmlToText("Olá<br>mundo"), "Olá\nmundo");
  assertEquals(htmlToText("Olá<br/>mundo"), "Olá\nmundo");
  assertEquals(htmlToText("Olá<br />mundo"), "Olá\nmundo");
});

Deno.test("htmlToText: HTML entities decodificadas", () => {
  assertEquals(htmlToText("Caro &amp; Cia."), "Caro & Cia.");
  assertEquals(htmlToText("&lt;tag&gt;"), "<tag>");
  assertEquals(htmlToText("&quot;hello&quot;"), '"hello"');
  assertEquals(htmlToText("&#39;t"), "'t");
});

Deno.test("htmlToText: parágrafos consecutivos separados por linha em branco", () => {
  assertEquals(
    htmlToText("<p>Primeiro</p><p>Segundo</p><p>Terceiro</p>"),
    "Primeiro\n\nSegundo\n\nTerceiro",
  );
});

Deno.test("htmlToText: divs aninhados não geram excesso de newlines", () => {
  const html = "<div><div><p>X</p></div></div>";
  // Independente de quantos </div> haja, o output não tem >2 newlines seguidas.
  const out = htmlToText(html);
  assertEquals(out.includes("\n\n\n"), false);
  assertEquals(out, "X");
});

Deno.test("htmlToText: template real (invite) - output sensato", () => {
  const html = inviteEmailHtml({
    occupantName: "João Silva",
    condominiumName: "Edifício Exemplo",
    designationType: "building",
    acceptUrl: "https://app.mague.pt/accept?token=abc123",
    ttl: "24 horas",
  });
  const text = htmlToText(html);

  // Estrutura essencial preservada
  assertEquals(text.includes("EDIFÍCIO"), true);
  // Text-transform:uppercase do CSS não afeta o conteúdo plain - fica
  // como foi escrito no template.
  assertEquals(text.includes("Edifício Exemplo"), true);
  assertEquals(text.includes("João Silva"), true);
  assertEquals(text.includes("24 horas"), true);
  assertEquals(text.includes("https://app.mague.pt/accept?token=abc123"), true);
  // Sem HTML residual
  assertEquals(/<[a-z]/i.test(text), false);
  // Sem newlines triplas
  assertEquals(text.includes("\n\n\n"), false);
});

Deno.test("htmlToText: template real (recibo) - quantia e número visíveis", () => {
  const html = receiptIssuedEmailHtml({
    recipientName: "Maria Santos",
    condominiumName: "Vila Real",
    designationType: "condominium",
    unitDesignation: "1ºA",
    unitIdentifier: "matr-123",
    receiptNumber: "R-2026/0042",
    amount: "210,00 €",
    paymentDate: "15/05/2026",
    receiptUrl: "https://app.mague.pt/portal/receipts/r_42",
  });
  const text = htmlToText(html);

  assertEquals(text.includes("Maria Santos"), true);
  assertEquals(text.includes("210,00 €"), true);
  assertEquals(text.includes("R-2026/0042"), true);
  assertEquals(text.includes("15/05/2026"), true);
  assertEquals(text.includes("1ºA"), true);
  assertEquals(text.includes("matr-123"), true);
  assertEquals(text.includes("https://app.mague.pt/portal/receipts/r_42"), true);
});
