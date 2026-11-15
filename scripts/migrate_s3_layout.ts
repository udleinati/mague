// scripts/migrate_s3_layout.ts
//
// One-shot: migra ficheiros de receipts + insurance policies do formato
// antigo (resource-first) para o novo (condo-first sharded). Idempotente:
// linhas já no formato novo são puladas.
//
// Padrões:
//   ANTIGO receipts:  receipts/<cid>/<year>/<year>-<num>.pdf
//   NOVO   receipts:  <cid>/receipts/<shard>/<receiptId>/<year>-<num>.pdf
//
//   ANTIGO insurance: insurance/<cid>/<unitId>/<policyId>.pdf
//   NOVO   insurance: <cid>/insurance/<shard>/<policyId>/<policyId>.pdf
//
// Fluxo por linha:
//   1. getObject(old)  - baixa bytes
//   2. putObject(new)  - sobe ao novo path (idempotente: re-puts são OK)
//   3. UPDATE storage_key = new   - só se 1+2 sucederam
//   4. deleteObject(old) - só se 3 sucedeu
//
// Se algo falhar a meio, fica órfão (não rebenta nada): ficheiro novo
// existe mas BD ainda aponta para o antigo (ou vice-versa). Re-correr o
// script é seguro - detecta o estado e retoma de onde ficou.
//
// USO (dentro do container `mague-api`):
//
//   # 1. DRY-RUN - só imprime o plano, NÃO escreve nada:
//   docker exec mague-api deno run -A scripts/migrate_s3_layout.ts --dry-run
//
//   # 2. EXECUÇÃO - copia + actualiza BD + apaga antigos:
//   docker exec mague-api deno run -A scripts/migrate_s3_layout.ts
//
//   # 3. Apenas uma entidade (debug/teste):
//   docker exec mague-api deno run -A scripts/migrate_s3_layout.ts --only=receipts
//   docker exec mague-api deno run -A scripts/migrate_s3_layout.ts --only=insurance
//
// Em produção: faz dry-run primeiro, lê a contagem, depois execução real.
// Run repetida é seguro (idempotente - pula linhas já migradas).

import { eq } from "drizzle-orm";
import { postgres } from "$api/libs/postgres/postgres.ts";
import { schema } from "$api/libs/postgres/schemas/mod.ts";
import { deleteObject, getObject, putObject } from "$api/libs/storage/s3.ts";
import { buildEntityStorageKey } from "$api/libs/storage/storage_key.ts";

const args = new Set(Deno.args);
const dryRun = args.has("--dry-run");
const onlyArg = Deno.args.find((a) => a.startsWith("--only="))?.split("=")[1];
const only = onlyArg === "receipts" || onlyArg === "insurance" ? onlyArg : null;

console.log(`\n=== migrate_s3_layout ${dryRun ? "[DRY-RUN]" : "[REAL]"} ===`);
if (only) console.log(`(scope: only ${only})`);

type Counters = {
  total: number;
  skipped: number; // já no formato novo
  migrated: number; // copy + update + delete OK
  failed: number; // alguma etapa falhou
};

/**
 * Migra 1 linha. Devolve "skipped" | "migrated" | "failed".
 * Cada erro é apanhado e loggado - não aborta o batch.
 */
async function migrateOne(opts: {
  entity: "receipts" | "insurance";
  rowId: string;
  condominiumId: string;
  oldKey: string;
  newKey: string;
  updateBd: (newKey: string) => Promise<void>;
}): Promise<"skipped" | "migrated" | "failed"> {
  if (opts.oldKey === opts.newKey) return "skipped";

  console.log(`  ${opts.rowId} (${opts.condominiumId})`);
  console.log(`    old: ${opts.oldKey}`);
  console.log(`    new: ${opts.newKey}`);

  if (dryRun) return "migrated";

  try {
    // 1. Download
    const bytes = await getObject(opts.oldKey);
    // 2. Upload novo path. Idempotente - re-puts não custam.
    await putObject(opts.newKey, bytes, "application/pdf");
    // 3. Update BD
    await opts.updateBd(opts.newKey);
    // 4. Apaga antigo (só agora - depois da BD aceitar).
    await deleteObject(opts.oldKey);
    console.log(`    ✓ migrado`);
    return "migrated";
  } catch (e) {
    console.error(`    ✗ falhou: ${(e as Error).message}`);
    return "failed";
  }
}

// ─── RECEIPTS ──────────────────────────────────────────────────────────
async function migrateReceipts(): Promise<Counters> {
  const c: Counters = { total: 0, skipped: 0, migrated: 0, failed: 0 };
  console.log("\n→ Receipts");

  const rows = await postgres.query((db) =>
    db.query.receipt.findMany({
      columns: { id: true, condominiumId: true, storageKey: true, year: true, sequence: true },
    })
  );
  c.total = rows.length;

  for (const r of rows) {
    if (!r.storageKey) {
      c.skipped++;
      continue;
    }
    // Formato antigo: começa por "receipts/". Novo: começa por "<cid>/".
    if (!r.storageKey.startsWith("receipts/")) {
      c.skipped++;
      continue;
    }
    const filename = `${r.year}-${String(r.sequence).padStart(5, "0")}.pdf`;
    const newKey = buildEntityStorageKey({
      entity: "receipts",
      condominiumId: r.condominiumId,
      entityId: r.id,
      filename,
    });
    const result = await migrateOne({
      entity: "receipts",
      rowId: r.id,
      condominiumId: r.condominiumId,
      oldKey: r.storageKey,
      newKey,
      updateBd: (nk) =>
        postgres.query((db) =>
          db.update(schema.receipt).set({ storageKey: nk, updatedAt: new Date() }).where(
            eq(schema.receipt.id, r.id),
          )
        ),
    });
    c[result]++;
  }
  return c;
}

// ─── INSURANCE POLICIES ────────────────────────────────────────────────
async function migrateInsurance(): Promise<Counters> {
  const c: Counters = { total: 0, skipped: 0, migrated: 0, failed: 0 };
  console.log("\n→ Insurance policies");

  const rows = await postgres.query((db) =>
    db.query.insurancePolicy.findMany({
      columns: { id: true, condominiumId: true, storageKey: true },
    })
  );
  c.total = rows.length;

  for (const r of rows) {
    if (!r.storageKey) {
      c.skipped++;
      continue;
    }
    if (!r.storageKey.startsWith("insurance/")) {
      c.skipped++;
      continue;
    }
    // O policyId é o stem do filename antigo (insurance/<cid>/<unitId>/<policyId>.pdf).
    // Usamos r.id por segurança - é o que sabemos do BD.
    const filename = `${r.id}.pdf`;
    const newKey = buildEntityStorageKey({
      entity: "insurance",
      condominiumId: r.condominiumId,
      entityId: r.id,
      filename,
    });
    const result = await migrateOne({
      entity: "insurance",
      rowId: r.id,
      condominiumId: r.condominiumId,
      oldKey: r.storageKey,
      newKey,
      updateBd: (nk) =>
        postgres.query((db) =>
          db.update(schema.insurancePolicy).set({ storageKey: nk, updatedAt: new Date() })
            .where(eq(schema.insurancePolicy.id, r.id))
        ),
    });
    c[result]++;
  }
  return c;
}

// ─── RUN ───────────────────────────────────────────────────────────────
function printSummary(label: string, c: Counters): void {
  console.log(`  ${label}: total=${c.total} migrated=${c.migrated} skipped=${c.skipped} failed=${c.failed}`);
}

const summary: Record<string, Counters> = {};
if (!only || only === "receipts") summary.receipts = await migrateReceipts();
if (!only || only === "insurance") summary.insurance = await migrateInsurance();

console.log(`\n=== resumo ${dryRun ? "[DRY-RUN]" : "[REAL]"} ===`);
for (const [k, v] of Object.entries(summary)) printSummary(k, v);

const anyFailed = Object.values(summary).some((c) => c.failed > 0);
if (anyFailed) {
  console.error("\n✗ Alguns ficheiros falharam - re-corre o script para retomar.");
  Deno.exit(1);
}
console.log(dryRun ? "\nDry-run completo. Sem alterações." : "\n✓ Migração completa.");
Deno.exit(0);
