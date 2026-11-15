// Smoke: as rotas de pré-visualização da convocatória devolvem
// `200 application/pdf` e são READ-ONLY (não mudam estado nem criam runs).
//
//   GET .../convocation.pdf - convocatória (ordem do dia + datas + textos)
//   GET .../proxy.pdf        - modelo de procuração (amostra)
//
// Intenção (Rule 9): a pré-visualização produz um PDF válido em qualquer
// estado (aqui `draft`) e NÃO oficializa nada - o `status` continua `draft`
// depois de gerar. Só o envio muda estado/cria runs.
//
// Custo Chromium (renderPdf real): mantido leve - 1 render por rota.

import { assertEquals } from "@std/assert";
import { describe, it } from "@std/testing/bdd";
import { Client } from "$shared/client/mod.ts";
import { loginAsSuper } from "./_helpers/auth.ts";
import { type ScenarioFixture, seedScenario } from "./_helpers/fixtures.ts";

const BASE_URL = "http://localhost:3000";
const client = new Client({ baseUrl: BASE_URL });
const MASTER = await loginAsSuper();

// Lê uma rota PDF crua (não passa pelo Client JSON): status + content-type +
// magic bytes "%PDF" (header canónico de um PDF válido).
async function getPdf(path: string, headers: Record<string, string>) {
  const res = await fetch(`${BASE_URL}${path}`, { headers });
  const contentType = res.headers.get("content-type") ?? "";
  const bytes = new Uint8Array(await res.arrayBuffer());
  const magic = String.fromCharCode(...bytes.slice(0, 4));
  return { status: res.status, contentType, magic, byteLength: bytes.byteLength };
}

describe("admin assembly - pré-visualização PDF da convocatória + procuração", () => {
  let fx: ScenarioFixture;
  let assemblyId = "";
  const hdr = () => fx.hdr();
  const base = () => `/v1/admin/condominiums/${fx.condominium.id}/assemblies/${assemblyId}`;

  it("setup - condo + assembleia (draft) + textos + ordem do dia", async () => {
    fx = await seedScenario(client, MASTER).withCondo("Convocation PDF Condo").build();

    const { data, status } = await client.admin.createAssembly(
      {
        type: "ordinary",
        scheduledAt: "2026-07-10T19:00:00+00:00",
        secondConvocationAt: "2026-07-10T19:30:00+00:00",
        location: "Sala do condomínio",
      },
      { headers: hdr() },
    );
    assertEquals(status, 201);
    assertEquals(data.status, "draft"); // nasce em rascunho
    assemblyId = data.id as string;

    // intro/footer da convocatória - editáveis em draft (PATCH).
    await client.admin.updateAssembly(
      assemblyId,
      {
        convocationIntro: "Caros condóminos, convocamos a assembleia anual.",
        convocationFooter: "Documentos disponíveis no portal. Procurações até à hora da reunião.",
      },
      { headers: hdr() },
    );

    await client.admin.createAssemblyAgendaItem(
      assemblyId,
      { sequence: 1, subject: "Aprovação do orçamento 2026", itemType: "approve_budget" },
      { headers: hdr() },
    );
    await client.admin.createAssemblyAgendaItem(
      assemblyId,
      { sequence: 2, subject: "Outros assuntos", itemType: "info" },
      { headers: hdr() },
    );
  });

  it("convocation.pdf - 200 application/pdf, PDF válido", async () => {
    const r = await getPdf(`${base()}/convocation.pdf`, hdr());
    assertEquals(r.status, 200);
    assertEquals(r.contentType.includes("application/pdf"), true);
    assertEquals(r.magic, "%PDF");
  });

  it("proxy.pdf (procuração) - 200 application/pdf, PDF válido", async () => {
    const r = await getPdf(`${base()}/proxy.pdf`, hdr());
    assertEquals(r.status, 200);
    assertEquals(r.contentType.includes("application/pdf"), true);
    assertEquals(r.magic, "%PDF");
  });

  it("read-only - estado continua `draft` após gerar os PDFs", async () => {
    const { data } = await client.admin.getAssembly(assemblyId, { headers: hdr() });
    assertEquals(data.status, "draft");
  });

  it("cleanup", async () => {
    await fx.cleanup();
  });
});
