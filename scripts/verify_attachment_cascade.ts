// scripts/verify_attachment_cascade.ts
//
// Smoke test E2E para cascade S3 ao apagar uma entidade com anexos
// (ADR 0021). Aplicável a qualquer entidade que use core.attachment
// polimórfica - pathology, ticket, document, assembly, inspection, insurance.
//
// Fluxo:
//   1. Cria entidade (default: pathology) via API.
//   2. Upload de 3 anexos via API multipart.
//   3. Verifica que os 3 objects EXISTEM no S3 (HEAD).
//   4. Verifica que as 3 rows EXISTEM em core.attachment com deletedAt=null.
//   5. Apaga a entidade via DELETE da API.
//   6. Verifica que os 3 objects NÃO existem no S3 (HEAD 404).
//   7. Verifica que as 3 rows ficaram com deletedAt != null.
//   8. Verifica que a entidade-pai ficou com deletedAt != null.
//
// USO (dentro do container `mague-api` ou local com Deno):
//   docker exec mague-api deno run -A scripts/verify_attachment_cascade.ts
//
// Configurável via env: VERIFY_CID (default MgX001), VERIFY_EMAIL/PASSWORD.

import { eq } from "drizzle-orm";
import { postgres } from "$api/libs/postgres/postgres.ts";
import { schema } from "$api/libs/postgres/schemas/mod.ts";
import { objectExists } from "$api/libs/storage/s3.ts";

// API URL: dentro do container `mague-api`, localhost serve. Override via env
// se correr de fora do docker.
const API = Deno.env.get("VERIFY_API_URL") ?? "http://localhost:3000";
const CID = Deno.env.get("VERIFY_CID") ?? "MgX001";
const EMAIL = Deno.env.get("VERIFY_EMAIL") ?? "admin@mague.pt";
const PASSWORD = Deno.env.get("VERIFY_PASSWORD") ?? "test";

console.log(`\n=== verify_attachment_cascade ===`);
console.log(`API:   ${API}`);
console.log(`Condo: ${CID}`);
console.log(`User:  ${EMAIL}\n`);

// ─── 1. Login ──────────────────────────────────────────────────────────────
const loginRes = await fetch(`${API}/v1/auth/login`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ email: EMAIL, password: PASSWORD }),
});
if (!loginRes.ok) {
  console.error(`Login falhou (${loginRes.status})`);
  Deno.exit(1);
}
const token = (await loginRes.json()).data.token as string;
const authHeader = { Authorization: `Bearer ${token}` };

// ─── 2. Criar pathology ────────────────────────────────────────────────────
console.log("→ Criar patologia…");
const createRes = await fetch(`${API}/v1/admin/condominiums/${CID}/pathologies`, {
  method: "POST",
  headers: { ...authHeader, "Content-Type": "application/json" },
  body: JSON.stringify({
    title: "[smoke test] cascade S3",
    description: "Patologia temporária criada por verify_attachment_cascade.ts",
    category: "other",
    affectsCommonArea: true,
  }),
});
if (!createRes.ok) {
  console.error("Create falhou:", await createRes.text());
  Deno.exit(1);
}
const pathology = (await createRes.json()).data;
const pid = pathology.id as string;
console.log(`  criada: ${pathology.code} (${pid})`);

// ─── 3. Upload 3 anexos ────────────────────────────────────────────────────
// Magic bytes do PDF (`%PDF`) - mime guard valida o conteúdo, não só o label.
console.log("→ Upload de 3 anexos…");
const uploadedKeys: string[] = [];
const PDF_MAGIC = "%PDF-1.4\n";
for (let i = 1; i <= 3; i++) {
  const form = new FormData();
  const content = `${PDF_MAGIC}cascade-test-${i}-${Date.now()}\n%%EOF\n`;
  form.append("file", new Blob([content], { type: "application/pdf" }), `foto-${i}.pdf`);
  const r = await fetch(
    `${API}/v1/admin/condominiums/${CID}/pathologies/${pid}/attachments`,
    { method: "POST", headers: authHeader, body: form },
  );
  if (!r.ok) {
    console.error(`Upload ${i} falhou:`, await r.text());
    Deno.exit(1);
  }
  uploadedKeys.push(((await r.json()).data as { id: string }).id);
}
console.log(`  3 anexos criados: ${uploadedKeys.join(", ")}`);

// ─── 4. Read storage_keys directos do DB ───────────────────────────────────
const rowsBefore = await postgres.query((db) =>
  db.query.attachment.findMany({
    where: (a, ops) =>
      ops.and(
        ops.eq(a.entityType, "pathology"),
        ops.eq(a.entityId, pid),
      ),
    columns: { id: true, storageKey: true, deletedAt: true },
  })
);
console.log(`→ DB: ${rowsBefore.length} rows attachment (esperado 3)`);
for (const r of rowsBefore) {
  console.log(`  ${r.id}  deletedAt=${r.deletedAt}  key=${r.storageKey}`);
}

// ─── 5. Verificar que objects existem no S3 ───────────────────────────────
console.log("→ S3 HEAD ANTES do delete (esperado: TODOS existem)");
const beforeExists: boolean[] = [];
for (const r of rowsBefore) {
  const ex = await objectExists(r.storageKey);
  beforeExists.push(ex);
  console.log(`  ${ex ? "✓" : "✗"} ${r.storageKey}`);
}
if (!beforeExists.every(Boolean)) {
  console.error("Algum object não existia no S3 ANTES do delete - aborta.");
  Deno.exit(1);
}

// ─── 6. DELETE pathology via API ──────────────────────────────────────────
console.log("→ DELETE patologia…");
const delRes = await fetch(`${API}/v1/admin/condominiums/${CID}/pathologies/${pid}`, {
  method: "DELETE",
  headers: authHeader,
});
if (!delRes.ok && delRes.status !== 204) {
  console.error("Delete falhou:", await delRes.text());
  Deno.exit(1);
}
console.log(`  status=${delRes.status}`);

// ─── 7. Verificar que objects DESAPARECERAM do S3 ─────────────────────────
console.log("→ S3 HEAD APÓS delete (esperado: NENHUM existe)");
const afterExists: boolean[] = [];
for (const r of rowsBefore) {
  const ex = await objectExists(r.storageKey);
  afterExists.push(ex);
  console.log(`  ${ex ? "✗ AINDA EXISTE" : "✓ apagado"} ${r.storageKey}`);
}

// ─── 8. Verificar DB: rows ficaram com deleted_at ─────────────────────────
const rowsAfter = await postgres.query((db) =>
  db.query.attachment.findMany({
    where: (a, ops) =>
      ops.and(
        ops.eq(a.entityType, "pathology"),
        ops.eq(a.entityId, pid),
      ),
    columns: { id: true, deletedAt: true },
  })
);
console.log(`→ DB attachment rows após delete:`);
let allSoftDeleted = true;
for (const r of rowsAfter) {
  const ok = r.deletedAt != null;
  console.log(`  ${ok ? "✓" : "✗"} ${r.id} deletedAt=${r.deletedAt}`);
  if (!ok) allSoftDeleted = false;
}

const pathRow = await postgres.query((db) =>
  db.select({ deletedAt: schema.pathology.deletedAt })
    .from(schema.pathology)
    .where(eq(schema.pathology.id, pid))
);
const pathDeleted = pathRow[0]?.deletedAt != null;
console.log(`→ DB pathology row: ${pathDeleted ? "✓" : "✗"} deletedAt=${pathRow[0]?.deletedAt}`);

// ─── Resultado ─────────────────────────────────────────────────────────────
const allObjectsGone = afterExists.every((ex) => !ex);
const success = allObjectsGone && allSoftDeleted && pathDeleted;

console.log("\n══════════════════════════════════════");
console.log(success ? "✓ TODOS OS TESTES PASSARAM" : "✗ FALHOU");
console.log(`  S3 objects apagados:        ${allObjectsGone ? "✓" : "✗"}`);
console.log(`  Attachment rows soft-deleted: ${allSoftDeleted ? "✓" : "✗"}`);
console.log(`  Pathology soft-deleted:     ${pathDeleted ? "✓" : "✗"}`);
console.log("══════════════════════════════════════\n");

Deno.exit(success ? 0 : 1);
