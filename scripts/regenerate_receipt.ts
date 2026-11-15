// One-shot: re-renderiza o PDF de um recibo a partir dos snapshots já
// guardados na linha (compliance: PDF determinístico, mesmos dados, novo
// HTML+PDF caso template/lib tenham mudado, ou tarja "ANULADO" caso o
// recibo tenha sido anulado depois). Sobrepõe no S3 e actualiza
// storage_etag/file_size/file_sha256 + updated_at.
//
// Uso (dentro do container `mague-api`):
//   docker exec mague-api deno run -A scripts/regenerate_receipt.ts \
//     <condominiumId> <receiptId>

import { postgres } from "$api/libs/postgres/postgres.ts";
import { renderAndStorePdfFromSnapshots } from "$api/modules/admin/receipt/pdf.ts";
import { env } from "$config/env.ts";

if (Deno.args.length < 2) {
  console.error("Uso: regenerate_receipt.ts <condominiumId> <receiptId>");
  Deno.exit(1);
}

const [condominiumId, receiptId] = Deno.args;
console.log(`→ Regerar recibo ${receiptId} (condomínio ${condominiumId})`);

const receipt = await postgres.query((db) =>
  db.query.receipt.findFirst({
    where: (r, ops) =>
      ops.and(
        ops.eq(r.id, receiptId),
        ops.eq(r.condominiumId, condominiumId),
      ),
  })
);
if (!receipt) {
  console.error(`✗ Recibo ${receiptId} não encontrado em ${condominiumId}`);
  Deno.exit(1);
}
if (receipt.deletedAt) {
  console.error(`✗ Recibo ${receipt.number} está soft-deleted (${receipt.deletedAt})`);
  Deno.exit(1);
}

console.log(
  `  número=${receipt.number}, montante=${(receipt.amountCents / 100).toFixed(2)}€, ` +
    `recipients=${receipt.recipientsSnapshot.length}, lines=${receipt.linesSnapshot.length}`,
);
if (receipt.voidedAt) {
  console.warn(`⚠  ANULADO em ${receipt.voidedAt}: "${receipt.voidedReason ?? ""}"`);
}

const oldSha = receipt.fileSha256;
const oldSize = receipt.fileSize;

const put = await renderAndStorePdfFromSnapshots(postgres, receipt, env.panelBaseUrl);

console.log("");
console.log(`✓ Recibo ${receipt.number} regenerado.`);
console.log(`  size: ${oldSize} → ${put.size} bytes`);
console.log(`  sha:  ${(oldSha ?? "-").substring(0, 16)}… → ${put.sha256.substring(0, 16)}…`);
console.log(`  PDF:  http://localhost:3400/admin/c/${condominiumId}/recibos/${receiptId}/pdf`);
Deno.exit(0);
