// scripts/sweep_document_attachments.ts
//
// Read-only: varre TODOS os anexos vivos de documentos (core.attachment,
// entity_type='document', deleted_at IS NULL) e verifica se o objeto S3
// apontado por storage_key existe mesmo. Para os que falham, lista os objects
// reais sob o prefixo do parent (para detetar case/path trocado vs perdido).
//
// NÃO escreve nada. Útil para descobrir "ficheiros perdidos" depois de um
// backup/restore que desalinhou shards.
//
// USO (dentro do container `mague-api`):
//   docker exec mague-api deno run -A scripts/sweep_document_attachments.ts
//   docker exec mague-api deno run -A scripts/sweep_document_attachments.ts --cid=MgX001

import { ListObjectsV2Command, S3Client } from "npm:@aws-sdk/client-s3@3.879.0";
import { postgres } from "$api/libs/postgres/postgres.ts";
import { schema } from "$api/libs/postgres/schemas/mod.ts";
import { objectExists } from "$api/libs/storage/s3.ts";
import { env } from "$config/env.ts";

const cidArg = Deno.args.find((a) => a.startsWith("--cid="))?.split("=")[1];

console.log(`\n=== sweep_document_attachments ===`);
console.log(`bucket=${env.s3.bucket}  endpoint=${env.s3.endpoint}`);
if (cidArg) console.log(`cid=${cidArg}`);

const rows = await postgres.query((db) =>
  db.query.attachment.findMany({
    where: (a, ops) =>
      cidArg
        ? ops.and(
          ops.eq(a.entityType, "document"),
          ops.isNull(a.deletedAt),
          ops.eq(a.condominiumId, cidArg),
        )
        : ops.and(ops.eq(a.entityType, "document"), ops.isNull(a.deletedAt)),
    columns: { id: true, condominiumId: true, entityId: true, filename: true, storageKey: true },
  })
);
console.log(`\nAnexos de documentos vivos: ${rows.length}\n`);

const s3 = new S3Client({
  endpoint: env.s3.endpoint,
  region: env.s3.region,
  credentials: { accessKeyId: env.s3.accessKey, secretAccessKey: env.s3.secretKey },
  forcePathStyle: env.s3.forcePathStyle,
});

// Lista objects sob <cid>/documents/ que contenham parentId (para sugerir a key real).
async function realKeysFor(cid: string, parentId: string): Promise<string[]> {
  const prefix = `${cid}/documents/`;
  const out: string[] = [];
  let token: string | undefined;
  do {
    const res = await s3.send(new ListObjectsV2Command({
      Bucket: env.s3.bucket,
      Prefix: prefix,
      ContinuationToken: token,
      MaxKeys: 1000,
    }));
    for (const c of res.Contents ?? []) {
      if (c.Key && c.Key.includes(parentId)) out.push(c.Key);
    }
    token = res.IsTruncated ? res.NextContinuationToken : undefined;
  } while (token);
  return out;
}

let ok = 0;
const realign: { db: string; real: string }[] = [];
const gone: typeof rows = [];

for (const r of rows) {
  const exists = await objectExists(r.storageKey);
  if (exists) {
    ok++;
    continue;
  }
  // Objeto não está na key da BD: procura o real sob o prefixo do parent.
  const candidates = await realKeysFor(r.condominiumId, r.entityId);
  // Candidato útil = mesmo attachment id no nome do ficheiro, case diferente no shard.
  const sameFile = candidates.find((k) => k.endsWith(`/${r.id}-${r.filename}`)) ?? candidates[0];
  if (sameFile) {
    realign.push({ db: r.storageKey, real: sameFile });
    console.log(`MISMATCH  ${r.id}  (${r.condominiumId}/${r.entityId})`);
    console.log(`   db:   ${r.storageKey}`);
    console.log(`   real: ${sameFile}`);
  } else {
    gone.push(r);
    console.log(`PERDIDO   ${r.id}  (${r.condominiumId}/${r.entityId})  filename=${r.filename}`);
    console.log(`   db:   ${r.storageKey}  -> SEM objeto no S3`);
  }
}

console.log(`\n--- resumo ---`);
console.log(`OK (objeto existe):        ${ok}`);
console.log(`MISMATCH (corrigível):     ${realign.length}`);
console.log(`PERDIDO (re-upload):       ${gone.length}`);

if (realign.length > 0) {
  console.log(`\n--- UPDATEs sugeridos (revê antes de aplicar) ---`);
  for (const m of realign) {
    console.log(
      `UPDATE core.attachment SET storage_key = '${m.real}' WHERE storage_key = '${m.db}';`,
    );
  }
}

Deno.exit(0);
