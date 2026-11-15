// Guard do seam de settlements (ADR 0001): TODOS os produtores TS passam por
// createSettlementInTx (validação + INSERT + effects). Um INSERT direto de
// settlement fora de operation.ts salta a validação canónica e/ou os effects -
// exatamente o bug que este teste impede de reaparecer.

import { assertEquals } from "@std/assert";
import { walk } from "@std/fs/walk";
import { fromFileUrl } from "@std/path";

const API_ROOT = fromFileUrl(new URL("../../../", import.meta.url));
const ALLOWED = ["modules/admin/settlement/operation.ts"];

Deno.test("nenhum INSERT direto de settlement fora do seam (operation.ts)", async () => {
  const offenders: string[] = [];
  for await (
    const entry of walk(API_ROOT, { exts: [".ts"], skip: [/_test\.ts$/, /node_modules/] })
  ) {
    const rel = entry.path.slice(API_ROOT.length).replaceAll("\\", "/");
    if (ALLOWED.includes(rel)) continue;
    const src = await Deno.readTextFile(entry.path);
    if (/insert\(\s*schema\.settlement\s*\)/.test(src)) {
      offenders.push(rel);
    }
  }
  assertEquals(
    offenders,
    [],
    `INSERT direto de settlement fora do seam - usar createSettlementInTx: ${offenders.join(", ")}`,
  );
});
