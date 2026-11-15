// Pentest E2E: os endpoints de upload de attachments (charge, ticket,
// inspection) não podem aceitar um mime type controlado pelo cliente sem o
// validar - servir o ficheiro inline com esse mime permite Stored XSS:
//
// 1. Upload `<svg><script>alert(1)</script></svg>` como `image/svg+xml`.
//    Quando outro user (admin/manager) clica para abrir, o browser RENDERIZA
//    o SVG como documento top-level e executa o `<script>` no contexto da
//    origem do panel. Roubo de sessão (na medida do possível com httpOnly),
//    phishing via DOM, abuso da API em nome do utilizador.
//
// 2. Upload `<html><script>...</script></html>` como `text/html` ou
//    `image/png` (mime spoof). Browser pode aplicar MIME-sniffing em
//    cenários antigos.
//
// Defesas (`validate_attachment.ts`):
//   a) MIME-allowlist server-side: só `image/jpeg|png|webp|heic|heif` e
//      `application/pdf`. Rejeita `image/svg+xml`, `text/html`, etc.
//   b) Magic-bytes do ficheiro verificados contra o mime declarado.
//   c) `Content-Disposition: attachment` para mime que não seja
//      imagem-bitmap ou PDF (defesa em profundidade).
//   d) `Content-Security-Policy: default-src 'none'; sandbox` no
//      response de serve.

import { assertEquals, assertNotEquals } from "@std/assert";
import { describe, it } from "@std/testing/bdd";
import { ApiError, Client, type Condominium } from "$shared/client/mod.ts";
import { loginAsSuper } from "./_helpers/auth.ts";

const BASE_URL = "http://localhost:3000";
const client = new Client({ baseUrl: BASE_URL });
const MASTER = await loginAsSuper();

const SVG_PAYLOAD =
  '<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"><script>alert(1)</script></svg>';

describe("security - attachment XSS via mime spoofing", () => {
  let condo: Condominium;
  let ticketId = "";

  const hdr = () => ({ ...MASTER, "x-condominium-id": condo.id });

  it("setup", async () => {
    const { data: c } = await client.super.createCondominium(
      { name: "XSS Pentest Condo" },
      { headers: MASTER },
    );
    condo = c;
    const { data: t } = await client.admin.createTicket(
      { title: "XSS test", category: "elevator", priority: "low" },
      { headers: hdr() },
    );
    ticketId = t.id;
  });

  it(
    "REGRESSION: upload de SVG com `image/svg+xml` deve ser " +
      "REJEITADO - SVG é renderizável + executa `<script>` em browsers.",
    async () => {
      const file = new File([SVG_PAYLOAD], "evil.svg", { type: "image/svg+xml" });
      // A API rejeita com 400/415.
      let didReject = false;
      try {
        await client.admin.uploadTicketAttachment(ticketId, file, { headers: hdr() });
      } catch (err) {
        if (err instanceof ApiError) {
          didReject = err.statusCode === 400 || err.statusCode === 415;
        }
      }
      assertEquals(
        didReject,
        true,
        "Upload de SVG devia ser rejeitado (mime não está na allowlist).",
      );
    },
  );

  it(
    "REGRESSION: upload de HTML disfarçado de `image/png` deve ser " +
      "REJEITADO via verificação de magic-bytes (PNG real começa com 89 50 4E 47).",
    async () => {
      const htmlPayload = '<html><script>alert("xss")</script></html>';
      const file = new File([htmlPayload], "image.png", { type: "image/png" });
      let didReject = false;
      try {
        await client.admin.uploadTicketAttachment(ticketId, file, { headers: hdr() });
      } catch (err) {
        if (err instanceof ApiError) {
          didReject = err.statusCode === 400 || err.statusCode === 415;
        }
      }
      assertEquals(
        didReject,
        true,
        "HTML com mime spoofado de image/png devia ser rejeitado (magic-byte mismatch).",
      );
    },
  );

  it(
    "Defesa em profundidade: serve de attachment legítimo deve incluir " +
      "header `Content-Security-Policy` restritivo + `X-Content-Type-Options: nosniff`.",
    async () => {
      // Upload PNG válido (1x1 pixel)
      const pngBytes = new Uint8Array([
        137,
        80,
        78,
        71,
        13,
        10,
        26,
        10,
        0,
        0,
        0,
        13,
        73,
        72,
        68,
        82,
        0,
        0,
        0,
        1,
        0,
        0,
        0,
        1,
        8,
        6,
        0,
        0,
        0,
        31,
        21,
        196,
        137,
        0,
        0,
        0,
        13,
        73,
        68,
        65,
        84,
        120,
        156,
        99,
        250,
        207,
        0,
        0,
        0,
        4,
        0,
        1,
        145,
        145,
        209,
        22,
        0,
        0,
        0,
        0,
        73,
        69,
        78,
        68,
        174,
        66,
        96,
        130,
      ]);
      const file = new File([pngBytes], "valid.png", { type: "image/png" });
      const { data: att } = await client.admin.uploadTicketAttachment(ticketId, file, {
        headers: hdr(),
      });

      // Fazer raw fetch para inspeccionar headers
      const url =
        `${BASE_URL}/v1/admin/condominiums/${condo.id}/tickets/${ticketId}/attachments/${att.id}`;
      const resp = await fetch(url, {
        headers: { "Authorization": `Bearer ${MASTER.Authorization?.replace("Bearer ", "")}` },
      });
      await resp.body?.cancel();

      const csp = resp.headers.get("content-security-policy");
      const nosniff = resp.headers.get("x-content-type-options");
      assertNotEquals(csp, null, "Resposta de serve devia ter Content-Security-Policy");
      assertEquals(
        nosniff?.toLowerCase(),
        "nosniff",
        "Resposta de serve devia ter X-Content-Type-Options: nosniff",
      );
    },
  );

  it("cleanup", async () => {
    await client.super.deleteCondominium(condo.id, { headers: MASTER });
  });
});
