// scripts/cleanup_s3_orphans.ts
//
// Limpa ficheiros órfãos no bucket S3 - objects cuja key NÃO corresponde
// a nenhuma row viva na BD (core.attachment com deleted_at IS NULL, ou
// core.receipt). Aparecem por:
//
//   1. Deletes que apaguem a row sem apagar primeiro o objeto S3 (contra o
//      ADR 0021).
//   2. Uploads falhados a meio (INSERT da row rebenta após `putObject`).
//      O caller actual em `uploadAttachment` cleansa via `deleteObject` no
//      catch, mas se o processo morreu no meio (OOM, restart) o cleanup
//      não corre.
//
// Pode-se correr periodicamente em produção como manutenção. NÃO é
// substituto do pattern S3-first-then-BD (ADR 0021) - é só limpa-resto.
//
// Fluxo:
//   1. SELECT storage_key FROM core.attachment WHERE deleted_at IS NULL
//   2. SELECT storage_key FROM core.receipt
//   3. Lista todos objects no bucket via ListObjectsV2 (paginação)
//   4. Para cada object, se key ∉ {vivas} → órfão. Print + (opt) delete.
//
// USO (dentro do container `mague-api`):
//
//   # DRY-RUN - lista órfãos + count + tamanho total. Não escreve nada.
//   docker exec mague-api deno run -A scripts/cleanup_s3_orphans.ts
//
//   # REAL - apaga via deleteObject. Pede confirmação interactiva primeiro.
//   docker exec -it mague-api deno run -A scripts/cleanup_s3_orphans.ts --apply
//
//   # REAL sem confirmação (CI / cron):
//   docker exec mague-api deno run -A scripts/cleanup_s3_orphans.ts --apply --yes
//
//   # Filtrar por prefixo (útil para limitar a um condomínio):
//   docker exec mague-api deno run -A scripts/cleanup_s3_orphans.ts --prefix=MgX001/
//
// Idempotente: re-correr é seguro - objects já apagados saem da listagem.
// `deleteObject` do AWS SDK aceita keys já apagadas sem erro.

import {
  DeleteObjectCommand,
  ListObjectsV2Command,
  type ListObjectsV2CommandOutput,
  S3Client,
} from "npm:@aws-sdk/client-s3@3.879.0";
import { isNull } from "drizzle-orm";
import { postgres } from "$api/libs/postgres/postgres.ts";
import { schema } from "$api/libs/postgres/schemas/mod.ts";
import { env } from "$config/env.ts";

const args = new Set(Deno.args);
const apply = args.has("--apply");
const yes = args.has("--yes");
const prefixArg = Deno.args.find((a) => a.startsWith("--prefix="))?.split("=")[1] ?? "";

console.log(`\n=== cleanup_s3_orphans ${apply ? "[APPLY]" : "[DRY-RUN]"} ===`);
console.log(`bucket:   ${env.s3.bucket}`);
console.log(`endpoint: ${env.s3.endpoint}`);
if (prefixArg) console.log(`prefix:   ${prefixArg}`);

const s3 = new S3Client({
  endpoint: env.s3.endpoint,
  region: env.s3.region,
  credentials: {
    accessKeyId: env.s3.accessKey,
    secretAccessKey: env.s3.secretKey,
  },
  forcePathStyle: env.s3.forcePathStyle,
});

// ─── 1. Set de keys vivas ────────────────────────────────────────────────
// `core.attachment` (polimórfica, todos os entityTypes) - só deleted_at IS NULL.
// `core.receipt` - todas as rows; recibos não têm soft-delete (void
// re-renderiza no mesmo storage_key).
console.log("\nA carregar keys vivas da BD...");
const liveAttachments = await postgres.query((db) =>
  db.select({ storageKey: schema.attachment.storageKey })
    .from(schema.attachment)
    .where(isNull(schema.attachment.deletedAt))
);
const liveReceipts = await postgres.query((db) =>
  db.select({ storageKey: schema.receipt.storageKey })
    .from(schema.receipt)
);
const liveKeys = new Set<string>([
  ...liveAttachments.map((r) => r.storageKey),
  ...liveReceipts.map((r) => r.storageKey),
]);
console.log(`  attachment (deleted_at IS NULL): ${liveAttachments.length}`);
console.log(`  receipt:                          ${liveReceipts.length}`);
console.log(`  total keys vivas únicas:          ${liveKeys.size}`);

// ─── 2. Listar TODOS os objects no bucket (paginação) ─────────────────────
console.log("\nA listar objects no bucket...");
type ObjEntry = { key: string; size: number };
const allObjects: ObjEntry[] = [];
let continuationToken: string | undefined = undefined;
let page = 0;
do {
  page++;
  const res: ListObjectsV2CommandOutput = await s3.send(
    new ListObjectsV2Command({
      Bucket: env.s3.bucket,
      Prefix: prefixArg || undefined,
      ContinuationToken: continuationToken,
      MaxKeys: 1000,
    }),
  );
  for (const c of res.Contents ?? []) {
    if (c.Key) allObjects.push({ key: c.Key, size: c.Size ?? 0 });
  }
  continuationToken = res.IsTruncated ? res.NextContinuationToken : undefined;
  if (page % 5 === 0) console.log(`  ...${allObjects.length} objects até agora`);
} while (continuationToken);
console.log(`  total objects no bucket: ${allObjects.length}`);

// ─── 3. Cruzar: órfãos = objects cuja key não está em liveKeys ────────────
const orphans = allObjects.filter((o) => !liveKeys.has(o.key));
const orphanBytes = orphans.reduce((s, o) => s + o.size, 0);
console.log(`\nÓrfãos detectados: ${orphans.length}`);
console.log(`Tamanho total:     ${formatBytes(orphanBytes)}`);

if (orphans.length === 0) {
  console.log("\nNada a fazer. Bucket limpo.\n");
  Deno.exit(0);
}

// Print sample dos primeiros 20 (e por entityType).
console.log("\nAmostra (até 20):");
for (const o of orphans.slice(0, 20)) {
  console.log(`  ${o.key}  (${formatBytes(o.size)})`);
}
if (orphans.length > 20) console.log(`  ... (+${orphans.length - 20} mais)`);

// Breakdown por segundo segmento da key (entityType: receipts/insurance/etc).
const byType = new Map<string, { count: number; bytes: number }>();
for (const o of orphans) {
  const parts = o.key.split("/");
  // Keys novas: <cid>/<entityType>/<shard>/<id>/<file>
  // Keys antigas: <entityType>/<cid>/<...>
  const seg = parts.length >= 2 ? parts[1] : parts[0];
  const k = seg ?? "?";
  const cur = byType.get(k) ?? { count: 0, bytes: 0 };
  cur.count++;
  cur.bytes += o.size;
  byType.set(k, cur);
}
console.log("\nPor tipo (segundo segmento da key):");
for (const [t, v] of [...byType.entries()].sort((a, b) => b[1].bytes - a[1].bytes)) {
  console.log(`  ${t.padEnd(15)} ${String(v.count).padStart(6)} obj   ${formatBytes(v.bytes)}`);
}

// ─── 4. Apagar (se --apply) ──────────────────────────────────────────────
if (!apply) {
  console.log("\nDry-run apenas. Para apagar: re-correr com --apply.\n");
  Deno.exit(0);
}

if (!yes) {
  const input = prompt(`\nConfirmar delete de ${orphans.length} objects? Escreve "APAGAR" para confirmar:`);
  if (input !== "APAGAR") {
    console.log("Cancelado.");
    Deno.exit(1);
  }
}

console.log("\nA apagar...");
let deleted = 0;
let failed = 0;
for (const o of orphans) {
  try {
    await s3.send(new DeleteObjectCommand({ Bucket: env.s3.bucket, Key: o.key }));
    deleted++;
    if (deleted % 50 === 0) console.log(`  ...${deleted}/${orphans.length}`);
  } catch (e) {
    failed++;
    console.error(`  FALHOU ${o.key}: ${(e as Error).message}`);
  }
}
console.log(`\nDone. apagados=${deleted}  falhados=${failed}`);
Deno.exit(failed > 0 ? 1 : 0);

// ─── Helpers ─────────────────────────────────────────────────────────────

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`;
  return `${(n / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}
