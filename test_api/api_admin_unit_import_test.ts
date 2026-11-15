// Unit import flow: preview (XLSX upload → JSON) + commit (JSON → DB inserts).
//
// Cria um XLSX in-memory com 2 frações + 1 ocupante partilhado para cobrir
// a dedup por email/NIF. Depois testa:
//   1. GET template.xlsx devolve bytes XLSX
//   2. preview retorna units/occupants/links consistentes com o input
//   3. commit insere everything (units_created, occupants_created, links)
//   4. Re-commit com as mesmas designações → skipped (idempotência)

import { assertEquals } from "@std/assert";
import { describe, it } from "@std/testing/bdd";
import { Client, type Condominium } from "$shared/client/mod.ts";
import { loginAsSuper } from "./_helpers/auth.ts";
import * as XLSX from "xlsx";

const BASE_URL = "http://localhost:3000";
const client = new Client({ baseUrl: BASE_URL });
const MASTER = await loginAsSuper();

function buildUnitsXlsx(): Uint8Array {
  // Estrutura esperada pelo parser (libs/unit_import/parser.ts):
  //   A=designation, B=type, C=permillage, D=block, E=floor, F=door, G=desc,
  //   H=occupant name, I=email, J=phone, K=nif, L=relationship
  // Header vai na linha 1 (o parser salta qualquer linha cujo A1 comece por "frac").
  const rows: unknown[][] = [
    [
      "Fração",
      "Tipo",
      "Permilagem",
      "Bloco",
      "Piso",
      "Porta",
      "Descrição",
      "Nome ocupante",
      "Email",
      "Telefone",
      "NIF",
      "Relação",
    ],
    [
      "A",
      "residential",
      500,
      "1",
      "1",
      "A",
      "3 quartos",
      "Ana Teste",
      "ana@example.pt",
      "+351911111111",
      "123456789",
      "owner",
    ],
    [
      "B",
      "residential",
      500,
      "1",
      "1",
      "B",
      "2 quartos",
      "Ana Teste",
      "ana@example.pt",
      "+351911111111",
      "123456789",
      "tenant",
    ],
  ];
  const ws = XLSX.utils.aoa_to_sheet(rows);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, "Dados");
  const bytes = XLSX.write(wb, { type: "array", bookType: "xlsx" }) as Uint8Array;
  return bytes;
}

describe("admin units - import (preview + commit)", () => {
  let condo: Condominium;
  const hdr = () => ({ ...MASTER, "x-condominium-id": condo.id });

  it("setup - condo vazio", async () => {
    const { data } = await client.super.createCondominium(
      { name: "Unit Import Test" },
      { headers: MASTER },
    );
    condo = data;
  });

  it("GET /units/import/template.xlsx - devolve bytes XLSX", async () => {
    const res = await fetch(
      `${BASE_URL}/v1/admin/condominiums/${condo.id}/units/import/template.xlsx`,
      { headers: hdr() },
    );
    assertEquals(res.status, 200);
    const buf = new Uint8Array(await res.arrayBuffer());
    // XLSX é um ZIP - começa sempre com "PK\x03\x04" (0x50 0x4B 0x03 0x04).
    assertEquals(buf[0], 0x50);
    assertEquals(buf[1], 0x4B);
    assertEquals(buf.byteLength > 0, true);
  });

  let preview: {
    units: Array<Record<string, unknown>>;
    occupants: Array<Record<string, unknown>>;
    links: Array<Record<string, unknown>>;
    warnings: string[];
    summary: Record<string, unknown>;
  };

  it("preview - 2 frações + 1 ocupante deduplicado retorna JSON válido", async () => {
    const bytes = buildUnitsXlsx();
    // `File([bytes], ...)` teria problemas de tipagem em Deno (Uint8Array com
    // ArrayBufferLike vs BlobPart). Construir via Blob evita o cast.
    const blob = new Blob([bytes as BlobPart], {
      type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    });
    const file = new File([blob], "units.xlsx", { type: blob.type });
    const { data, status } = await client.admin.previewUnitsImport(
      file,
      "units.xlsx",
      { headers: hdr() },
    );
    assertEquals(status, 200);
    preview = data;
    assertEquals(preview.units.length, 2);
    assertEquals(preview.units[0].designation, "A");
    assertEquals(preview.units[1].designation, "B");
    // Ocupante Ana aparece em 2 linhas mas com mesmo email → dedup = 1.
    assertEquals(preview.occupants.length, 1);
    assertEquals(preview.occupants[0].email, "ana@example.pt");
    // 2 links (A=owner, B=tenant) para o mesmo ocupante.
    assertEquals(preview.links.length, 2);
  });

  it("commit - insere units + occupants + links", async () => {
    const { data, status } = await client.admin.commitUnitsImport(
      {
        units: preview.units,
        occupants: preview.occupants,
        links: preview.links,
      },
      { headers: hdr() },
    );
    assertEquals(status, 201);
    assertEquals(data.unitsCreated, 2);
    assertEquals(data.occupantsCreated, 1);
    assertEquals(data.linksCreated, 2);
  });

  it("list - condomínio tem as 2 units importadas", async () => {
    const { data } = await client.admin.listUnits({ headers: hdr() });
    assertEquals(data.length, 2);
    const designations = data.map((u) => u.designation).sort();
    assertEquals(designations, ["A", "B"]);
  });

  it("commit - re-executar com mesmos dados é idempotente (skips)", async () => {
    const { data } = await client.admin.commitUnitsImport(
      {
        units: preview.units,
        occupants: preview.occupants,
        links: preview.links,
      },
      { headers: hdr() },
    );
    // Units já existem pela designation (UNIQUE constraint) → skipped.
    assertEquals(data.unitsCreated, 0);
    assertEquals(data.units_skipped, 2);
    // Ocupante já existe pelo email → skipped.
    assertEquals(data.occupantsCreated, 0);
    assertEquals(data.occupants_skipped, 1);
  });

  it("teardown - apaga condomínio", async () => {
    await client.super.deleteCondominium(condo.id, { headers: MASTER });
  });
});
