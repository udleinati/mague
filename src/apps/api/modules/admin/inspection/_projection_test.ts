import { assertEquals } from "@std/assert";
import {
  computeInspectionStatus,
  formatInspectionAttachmentForResponse,
  formatInspectionForResponse,
} from "./_projection.ts";

Deno.test("computeInspectionStatus: inactive sobrepõe tudo", () => {
  // Mesmo com data passada (que daria "expired"), isActive=false força "inactive".
  assertEquals(
    computeInspectionStatus("2020-01-01", 30, false, "2026-05-03"),
    "inactive",
  );
  // Mesmo com data futura confortável, idem.
  assertEquals(
    computeInspectionStatus("2099-01-01", 30, false, "2026-05-03"),
    "inactive",
  );
});

Deno.test("computeInspectionStatus: validUntil no passado → expired", () => {
  assertEquals(
    computeInspectionStatus("2026-04-30", 30, true, "2026-05-03"),
    "expired",
  );
});

Deno.test("computeInspectionStatus: validUntil == today → expired", () => {
  // Edge case: o dia da expiração já conta como vencido (validUntil <= todayIso).
  assertEquals(
    computeInspectionStatus("2026-05-03", 30, true, "2026-05-03"),
    "expired",
  );
});

Deno.test("computeInspectionStatus: dentro da janela de aviso → due_soon", () => {
  // validUntil="2026-06-01", today="2026-05-15", notify=30 dias.
  // threshold = validUntil - 30 dias = 2026-05-02. today >= threshold → due_soon.
  assertEquals(
    computeInspectionStatus("2026-06-01", 30, true, "2026-05-15"),
    "due_soon",
  );
});

Deno.test("computeInspectionStatus: fora da janela de aviso → ok", () => {
  // validUntil="2026-08-01", today="2026-05-01", notify=30 dias.
  // threshold = 2026-07-02. today (05-01) < threshold → ok.
  assertEquals(
    computeInspectionStatus("2026-08-01", 30, true, "2026-05-01"),
    "ok",
  );
});

Deno.test("computeInspectionStatus: notifyDaysBefore=0 → due_soon só no próprio dia", () => {
  // notifyDaysBefore=0 → threshold = validUntil. today < threshold → ok.
  assertEquals(
    computeInspectionStatus("2026-06-01", 0, true, "2026-05-31"),
    "ok",
  );
  // No mesmo dia que validUntil já é "expired" (validUntil <= today bate primeiro).
  assertEquals(
    computeInspectionStatus("2026-06-01", 0, true, "2026-06-01"),
    "expired",
  );
});

Deno.test("computeInspectionStatus: cruza fronteira de mês na janela", () => {
  // validUntil="2026-03-15", notify=30 → threshold = 2026-02-13.
  // today="2026-02-13" → due_soon (>= threshold).
  // today="2026-02-12" → ok.
  assertEquals(
    computeInspectionStatus("2026-03-15", 30, true, "2026-02-13"),
    "due_soon",
  );
  assertEquals(
    computeInspectionStatus("2026-03-15", 30, true, "2026-02-12"),
    "ok",
  );
});

// ─── formatInspectionForResponse: fornecedor (supplier FK) ───────────────────

Deno.test("formatInspectionForResponse: surface supplierId + supplier nested", () => {
  const out = formatInspectionForResponse({
    id: "insp1",
    condominiumId: "c1",
    category: "elevator",
    description: "Elevador A",
    validUntil: "2099-12-31",
    notifyDaysBefore: 30,
    isActive: true,
    supplierId: "sup1",
    supplier: { id: "sup1", name: "Elevadores Teste, Lda", nif: "500000000" },
  });
  assertEquals(out.supplierId, "sup1");
  assertEquals(out.supplier, { id: "sup1", name: "Elevadores Teste, Lda", nif: "500000000" });
  // O resto da projeção continua intacto (status derivado das datas).
  assertEquals(out.status, "ok");
});

Deno.test("formatInspectionForResponse: sem fornecedor → supplierId/supplier a null", () => {
  // Caso de linha de listagem (sem o join do supplier) ou inspeção sem
  // fornecedor declarado: ambos os campos colapsam a null, nunca undefined.
  const out = formatInspectionForResponse({
    id: "insp2",
    category: "gas",
    description: "Gás",
    validUntil: "2099-12-31",
    notifyDaysBefore: 30,
    isActive: true,
  });
  assertEquals(out.supplierId, null);
  assertEquals(out.supplier, null);
});

// ─── formatInspectionAttachmentForResponse: data de upload ───────────────────

Deno.test("formatInspectionAttachmentForResponse: inclui createdAt (data de upload)", () => {
  // O template `attachments_list.vto` (layout list) mostra `a.createdAt`; este
  // teste tranca o contrato de que o campo vem na resposta da API.
  const created = new Date("2026-06-16T10:00:00Z");
  const out = formatInspectionAttachmentForResponse({
    id: "att1",
    entityId: "insp1",
    filename: "certificado.pdf",
    mimeType: "application/pdf",
    fileSize: 1234,
    createdAt: created,
  });
  assertEquals(out.id, "att1");
  assertEquals(out.inspectionId, "insp1"); // entityId → inspectionId
  assertEquals(out.filename, "certificado.pdf");
  assertEquals(out.createdAt, created);
});
