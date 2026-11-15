// O multipart que o admin envia leva o documento E a vigência decidida no
// formulário. Sem os campos extra no mesmo FormData, a API recusa com 422 e o
// Panel não tem como registar nem renovar com o documento entregue.

import { assertEquals, assertInstanceOf } from "@std/assert";
import { HttpClient } from "../http.ts";
// `admin.ts` regista os métodos no prototype ao carregar.
import { ManagerResource } from "../admin.ts";

function fakeManager() {
  const sent: { url: string; body: FormData }[] = [];
  const httpClient = {
    post: (url: string, init: RequestInit) => {
      sent.push({ url, body: init.body as FormData });
      return Promise.resolve(
        new Response(JSON.stringify({ data: { id: "p_new" } }), {
          status: 201,
          headers: { "content-type": "application/json" },
        }),
      );
    },
  } as unknown as HttpClient;
  return { manager: new ManagerResource(httpClient, () => "c1"), sent };
}

const PDF = new Uint8Array([0x25, 0x50, 0x44, 0x46]);

Deno.test("createInsurancePolicy: ficheiro e vigência viajam no mesmo multipart", async () => {
  const { manager, sent } = fakeManager();
  await manager.createInsurancePolicy(
    "u1",
    PDF,
    "apolice.pdf",
    "application/pdf",
    { validFrom: "2026-08-01", validTo: "2027-07-31" },
  );
  assertEquals(sent[0].url, "/v1/admin/condominiums/c1/units/u1/insurance");
  const file = sent[0].body.get("file");
  assertInstanceOf(file, File);
  assertEquals(file.name, "apolice.pdf");
  assertEquals(sent[0].body.get("validFrom"), "2026-08-01");
  assertEquals(sent[0].body.get("validTo"), "2027-07-31");
});

Deno.test("renewInsurancePolicyWithDocument: mesmo envelope, rota do renew", async () => {
  const { manager, sent } = fakeManager();
  await manager.renewInsurancePolicyWithDocument(
    "p_old",
    PDF,
    "renovacao.pdf",
    "application/pdf",
    { validFrom: "2026-11-26", validTo: "2027-11-26" },
  );
  assertEquals(sent[0].url, "/v1/admin/condominiums/c1/insurance/p_old/renew");
  assertEquals(sent[0].body.get("validFrom"), "2026-11-26");
  assertEquals(sent[0].body.get("validTo"), "2027-11-26");
});
