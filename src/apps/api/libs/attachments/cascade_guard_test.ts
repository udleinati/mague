// Guard do seam da cascata pai -> anexos (ADR 0021). A ordem "S3 antes da BD"
// já era impossível de errar DENTRO de `softDeleteAttachment`; o que se
// esquecia era invocá-la ao apagar o PAI. Eram sete loops copiados, e cada
// entidade nova tinha de se lembrar de escrever o oitavo.
//
// Mesmo padrão do `settlement/seam_guard_test.ts` (ADR 0001).

import { assertEquals } from "@std/assert";
import { walk } from "@std/fs/walk";
import { fromFileUrl } from "@std/path";

const API_ROOT = fromFileUrl(new URL("../../", import.meta.url));

/** Tabelas cujas linhas têm anexos em `core.attachment` (entity_type). */
const TABLES_WITH_ATTACHMENTS = [
  "charge",
  "ticket",
  "inspection",
  "assembly",
  "insurancePolicy",
  "document",
  "pathology",
];

/**
 * Ficheiros que apagam uma destas entidades SEM cascata, de propósito.
 * Cada entrada precisa de razão - se não a souberes escrever, é bug.
 */
const ALLOWED: Record<string, string> = {
  "modules/admin/insurance/state.ts":
    "undo-renewal: o gate `undoRenewalRefusal` recusa com attachmentCount !== 0, " +
    "logo a apólice apagada não tem anexos por construção (precondição, não cascata).",
};

const CASCADE_CALL = "softDeleteAttachmentsForEntity";
/** A CHAMADA, não o import: um import que ficou para trás não cascata nada. */
const CASCADE_CALL_RE = /softDeleteAttachmentsForEntity\s*\(/;

function offendingTables(src: string): string[] {
  return TABLES_WITH_ATTACHMENTS.filter((t) => {
    const hardDelete = new RegExp(`delete\\(\\s*schema\\.${t}\\s*\\)`).test(src);
    // Soft-delete: `.update(schema.X)` com um `deletedAt` na mesma cadeia.
    const softDelete = new RegExp(
      `update\\(\\s*schema\\.${t}\\s*\\)[\\s\\S]{0,400}?deletedAt`,
    ).test(src);
    return hardDelete || softDelete;
  });
}

Deno.test("apagar entidade com anexos passa sempre pela cascata do ADR 0021", async () => {
  const offenders: string[] = [];

  for await (
    const entry of walk(API_ROOT, { exts: [".ts"], skip: [/_test\.ts$/, /node_modules/] })
  ) {
    const rel = entry.path.slice(API_ROOT.length).replaceAll("\\", "/");
    if (rel in ALLOWED) continue;

    const src = await Deno.readTextFile(entry.path);
    if (CASCADE_CALL_RE.test(src)) continue;

    const tables = offendingTables(src);
    if (tables.length > 0) offenders.push(`${rel} (${tables.join(", ")})`);
  }

  assertEquals(
    offenders,
    [],
    `Apaga entidade com anexos sem cascata S3 - chamar ${CASCADE_CALL}() ANTES de tocar ` +
      `na linha do pai, ou justificar em ALLOWED: ${offenders.join(", ")}`,
  );
});

Deno.test("a allowlist não ganha entradas mudas", async () => {
  for (const [file, reason] of Object.entries(ALLOWED)) {
    assertEquals(
      reason.trim().length > 20,
      true,
      `${file} está na allowlist sem razão escrita`,
    );
    // Uma entrada obsoleta é tão má como uma em falta: se o ficheiro
    // desapareceu ou já cascata, a exceção deixou de fazer sentido.
    const src = await Deno.readTextFile(`${API_ROOT}${file}`);
    assertEquals(
      CASCADE_CALL_RE.test(src),
      false,
      `${file} já chama ${CASCADE_CALL}() - tirar da allowlist`,
    );
  }
});
