// scripts/diagnose_attachment_key.ts
//
// Read-only: reconcilia a `storage_key` na BD com os objects reais no bucket
// S3 para um attachment, quando o download dá "ficheiro não encontrado".
// Causa típica: shard de 1 char (`<cid>/<entity>/<a>/<b>/...`) com case
// trocado após backup/restore num FS case-insensitive.
//
// NÃO escreve nada. Lista a row da BD + todos os objects S3 cuja key contém
// o parentId, para veres em que case/path o ficheiro está mesmo (ou se sumiu).
//
// USO (dentro do container `mague-api`):
//   docker exec mague-api deno run -A scripts/diagnose_attachment_key.ts <cid> <entityFolder> <parentId>
//
// Exemplo:
//   docker exec mague-api deno run -A scripts/diagnose_attachment_key.ts AB1234 documents N5aaaaaaaa

import { ListObjectsV2Command, S3Client } from "npm:@aws-sdk/client-s3@3.879.0";
import { postgres } from "$api/libs/postgres/postgres.ts";
import { schema } from "$api/libs/postgres/schemas/mod.ts";
import { env } from "$config/env.ts";

const [cid, entityFolder, parentId] = Deno.args;
if (!cid || !entityFolder || !parentId) {
  console.error("Uso: diagnose_attachment_key.ts <cid> <entityFolder> <parentId>");
  Deno.exit(2);
}

console.log(`\n=== diagnose_attachment_key ===`);
console.log(`cid=${cid}  entity=${entityFolder}  parentId=${parentId}`);
console.log(`bucket=${env.s3.bucket}  endpoint=${env.s3.endpoint}\n`);

// ─── 1. Row(s) na BD ──────────────────────────────────────────────────────
// Inclui soft-deleted (deleted_at) para contexto.
const dbRows = await postgres.query((db) =>
  db.query.attachment.findMany({
    where: (a, ops) => ops.eq(a.entityId, parentId),
    columns: { id: true, storageKey: true, deletedAt: true, entityType: true },
  })
);

console.log("BD core.attachment (entity_id = parentId):");
if (dbRows.length === 0) console.log("  (nenhuma row)");
for (const r of dbRows) {
  console.log(
    `  ${r.id}  type=${r.entityType}  deleted_at=${r.deletedAt ? r.deletedAt.toISOString() : "NULL"}`,
  );
  console.log(`    db_key: ${r.storageKey}`);
}

// ─── 2. Objects reais no bucket sob <cid>/<entity>/ que contenham o parentId ─
const s3 = new S3Client({
  endpoint: env.s3.endpoint,
  region: env.s3.region,
  credentials: { accessKeyId: env.s3.accessKey, secretAccessKey: env.s3.secretKey },
  forcePathStyle: env.s3.forcePathStyle,
});

const prefix = `${cid}/${entityFolder}/`;
const matches: { key: string; size: number }[] = [];
let token: string | undefined;
do {
  const res = await s3.send(new ListObjectsV2Command({
    Bucket: env.s3.bucket,
    Prefix: prefix,
    ContinuationToken: token,
    MaxKeys: 1000,
  }));
  for (const c of res.Contents ?? []) {
    if (c.Key && c.Key.includes(parentId)) matches.push({ key: c.Key, size: c.Size ?? 0 });
  }
  token = res.IsTruncated ? res.NextContinuationToken : undefined;
} while (token);

console.log(`\nObjects S3 sob ${prefix} que contêm "${parentId}":`);
if (matches.length === 0) {
  console.log("  (NENHUM) -> os bytes não estão no bucket. Migration não resolve; é preciso re-upload.");
} else {
  for (const m of matches) console.log(`  s3_key: ${m.key}  (${m.size} B)`);
}

// ─── 3. Veredicto ─────────────────────────────────────────────────────────
console.log("\n--- veredicto ---");
const live = dbRows.find((r) => !r.deletedAt);
if (!live) {
  console.log("Row viva ausente. Nada a alinhar.");
} else if (matches.length === 0) {
  console.log("Objeto AUSENTE no S3. Sem migration possível: re-upload do ficheiro.");
} else if (matches.some((m) => m.key === live.storageKey)) {
  console.log("DB e S3 JÁ batem certo. O 404 tem outra causa - investigar logs.");
} else {
  console.log("MISMATCH: a row viva aponta para uma key que não existe no S3.");
  console.log(`  db_key:  ${live.storageKey}`);
  console.log(`  s3_real: ${matches[0].key}`);
  console.log("  -> migration: UPDATE core.attachment SET storage_key = '<s3_real>' WHERE storage_key = '<db_key>';");
}

Deno.exit(0);
