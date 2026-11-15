// scripts/realign_document_objects.ts
//
// Alinha os OBJETOS S3 dos anexos de documentos à `storage_key` que a BD já
// espera. Caso de uso: bucket case-sensitive (R2/S3 em prod) onde o objeto
// ficou num case de shard diferente do da BD (a BD guarda o shard em
// minúsculas, mas o objeto de prod nunca foi achatado e
// está em maiúsculas) -> getObject falha -> download 404.
//
// Faz COPY server-side (real -> key-da-BD). NÃO apaga o objeto antigo (fica
// como duplicado inofensivo; podes limpar depois com cleanup_s3_orphans).
// NÃO toca na BD. Dry-run por defeito.
//
// USO (no ambiente de PRODUÇÃO, dentro do container da API):
//   # 1. DRY-RUN - mostra o que faria, não escreve nada:
//   deno run -A scripts/realign_document_objects.ts
//   deno run -A scripts/realign_document_objects.ts --cid=MgX001
//
//   # 2. APLICAR - faz as cópias server-side:
//   deno run -A scripts/realign_document_objects.ts --apply

import {
  CopyObjectCommand,
  ListObjectsV2Command,
  S3Client,
} from "npm:@aws-sdk/client-s3@3.879.0";
import { postgres } from "$api/libs/postgres/postgres.ts";
import { schema } from "$api/libs/postgres/schemas/mod.ts";
import { objectExists } from "$api/libs/storage/s3.ts";
import { env } from "$config/env.ts";

const args = new Set(Deno.args);
const apply = args.has("--apply");
const cidArg = Deno.args.find((a) => a.startsWith("--cid="))?.split("=")[1];

console.log(`\n=== realign_document_objects ${apply ? "[APPLY]" : "[DRY-RUN]"} ===`);
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
let copied = 0;
let gone = 0;

for (const r of rows) {
  if (await objectExists(r.storageKey)) {
    ok++;
    continue;
  }
  const candidates = await realKeysFor(r.condominiumId, r.entityId);
  // Match exato pelo sufixo <id>-<filename>: garante que é o MESMO anexo,
  // só com case de shard diferente (não outro ficheiro do mesmo documento).
  const real = candidates.find((k) => k.endsWith(`/${r.id}-${r.filename}`));
  if (!real) {
    gone++;
    console.log(`PERDIDO  ${r.id}  (${r.condominiumId}/${r.entityId})  -> objeto não existe em lado nenhum. Re-upload.`);
    continue;
  }
  console.log(`COPY     ${r.id}`);
  console.log(`   de:   ${real}`);
  console.log(`   para: ${r.storageKey}`);
  if (apply) {
    await s3.send(new CopyObjectCommand({
      Bucket: env.s3.bucket,
      Key: r.storageKey,
      CopySource: `${env.s3.bucket}/${real}`,
    }));
    console.log(`   ✓ copiado`);
  }
  copied++;
}

console.log(`\n--- resumo ${apply ? "[APPLY]" : "[DRY-RUN]"} ---`);
console.log(`OK (já alinhado):        ${ok}`);
console.log(`${apply ? "copiados" : "a copiar"}:               ${copied}`);
console.log(`PERDIDOS (re-upload):    ${gone}`);
if (!apply && copied > 0) console.log(`\nDry-run apenas. Para aplicar: re-corre com --apply.`);

Deno.exit(0);
