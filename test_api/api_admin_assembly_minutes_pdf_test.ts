// Smoke: a rota da ATA devolve `200 application/pdf` (PDF válido) e é
// READ-ONLY (gerar a ata não muda o estado da assembleia nem arquiva nada).
//
//   GET .../minutes.pdf - ata (cabeçalho + presenças + deliberações + assinaturas)
//
// Intenção (Rule 9): a ata gera-se on-the-fly em qualquer estado (aqui já com
// ordem do dia mas sem presenças) e NÃO oficializa nada - o `status` continua
// como estava. O conteúdo detalhado da ata (texto por secção, pills de
// resultado, total de permilagem) é coberto pelo render test puro
// `src/apps/api/templates/assembly_minutes_render_test.ts` (sem Chromium).
//
// Custo Chromium (renderPdf real): mantido leve - 1 render.

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
  const contentDisposition = res.headers.get("content-disposition") ?? "";
  const bytes = new Uint8Array(await res.arrayBuffer());
  const magic = String.fromCharCode(...bytes.slice(0, 4));
  return { status: res.status, contentType, contentDisposition, magic };
}

describe("admin assembly - PDF da ata (minutes.pdf)", () => {
  let fx: ScenarioFixture;
  let assemblyId = "";
  const hdr = () => fx.hdr();
  const base = () => `/v1/admin/condominiums/${fx.condominium.id}/assemblies/${assemblyId}`;

  it("setup - condo + assembleia + ordem do dia", async () => {
    fx = await seedScenario(client, MASTER).withCondo("Minutes PDF Condo").build();

    const { data, status } = await client.admin.createAssembly(
      {
        type: "ordinary",
        scheduledAt: "2026-07-10T19:00:00+00:00",
        location: "Sala do condomínio",
        minutesNumber: "42",
      },
      { headers: hdr() },
    );
    assertEquals(status, 201);
    assemblyId = data.id as string;

    await client.admin.createAssemblyAgendaItem(
      assemblyId,
      { sequence: 1, subject: "Aprovação do orçamento 2026", itemType: "approve_budget" },
      { headers: hdr() },
    );
    await client.admin.createAssemblyAgendaItem(
      assemblyId,
      { sequence: 2, subject: "Ponto de situação", itemType: "info" },
      { headers: hdr() },
    );
  });

  it("minutes.pdf - 200 application/pdf, PDF válido, com nome de download", async () => {
    const r = await getPdf(`${base()}/minutes.pdf`, hdr());
    assertEquals(r.status, 200);
    assertEquals(r.contentType.includes("application/pdf"), true);
    assertEquals(r.magic, "%PDF");
    // Content-Disposition `inline` (pré-visualização: o panel abre numa nova aba,
    // não força download - ver minutes_pdf.ts) com o slug "ata-N42".
    assertEquals(r.contentDisposition.includes("inline"), true);
    assertEquals(r.contentDisposition.includes("ata-N42"), true);
  });

  it("read-only - gerar a ata não muda o estado da assembleia", async () => {
    const before = (await client.admin.getAssembly(assemblyId, { headers: hdr() })).data.status;
    await getPdf(`${base()}/minutes.pdf`, hdr());
    const after = (await client.admin.getAssembly(assemblyId, { headers: hdr() })).data.status;
    assertEquals(after, before);
  });

  it("cleanup", async () => {
    await fx.cleanup();
  });
});
