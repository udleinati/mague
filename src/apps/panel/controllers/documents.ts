import { render } from "$panel/render.ts";
import { type Document } from "$shared/client/mod.ts";
import { parseFormString } from "$panel/libs/form_parsing.ts";
import { proxyDownload } from "$panel/libs/download_proxy.ts";
import { client } from "$panel/client.ts";

const CATEGORY_LABELS: Record<string, string> = {
  minutes: "Ata",
  regulation: "Regulamento",
  contract: "Contrato",
  budget: "Orçamento",
  insurance: "Seguro",
  plant: "Planta",
  other: "Outro",
};

export async function listDocuments(filter?: { category?: string; visibility?: string }) {
  const { data: documents } = await client.admin.listDocuments();

  // Filtros aplicados client-side (lista pequena, geralmente <100).
  let filtered = documents;
  if (filter?.category) filtered = filtered.filter((d) => d.category === filter.category);
  if (filter?.visibility === "public") filtered = filtered.filter((d) => d.isPublic);
  if (filter?.visibility === "private") filtered = filtered.filter((d) => !d.isPublic);

  return await render("pages/documents/list.vto", {
    title: "Documentos",
    section: "documents",
    documents: filtered,
    totalCount: documents.length,
    publicCount: documents.filter((d) => d.isPublic).length,
    filter: filter ?? {},
    categoryLabels: CATEGORY_LABELS,
  });
}

export async function createDocument(form: Record<string, string | File>) {
  const body = {
    title: parseFormString(form, "title"),
    description: parseFormString(form, "description", { emptyAsNull: true }),
    category: parseFormString(form, "category", { default: "other" }) as Document["category"],
    isPublic: form.isPublic === "1" || form.isPublic === "true",
    publishedAt: String(form.publishedAt ?? "") || undefined,
  };
  const r = await client.admin.createDocument(body);
  return r.data;
}

export async function showDocument(documentId: string) {
  const { data: document } = await client.admin.getDocument(documentId);
  return await render("pages/documents/show.vto", {
    title: document.title,
    section: "documents",
    document,
    categoryLabels: CATEGORY_LABELS,
  });
}

export async function updateDocument(documentId: string, form: Record<string, string | File>) {
  const body: Record<string, unknown> = {
    title: parseFormString(form, "title"),
    description: parseFormString(form, "description", { emptyAsNull: true }),
    category: parseFormString(form, "category", { default: "other" }),
    // Sentinel isPublicSubmitted garante que desmarcar o checkbox chega ao backend.
    isPublic: form.isPublicSubmitted === "1"
      ? (form.isPublic === "1" || form.isPublic === "true")
      : undefined,
    publishedAt: String(form.publishedAt ?? "") || undefined,
  };
  for (const k of Object.keys(body)) if (body[k] === undefined) delete body[k];
  const r = await client.admin.updateDocument(documentId, body);
  return r.data;
}

export async function deleteDocument(documentId: string) {
  await client.admin.deleteDocument(documentId);
}

export async function uploadDocumentAttachment(documentId: string, file: File): Promise<void> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  await client.admin.uploadDocumentAttachment(
    documentId,
    bytes,
    file.name || "anexo",
    file.type || "application/octet-stream",
  );
}

export async function deleteDocumentAttachment(
  documentId: string,
  attachmentId: string,
): Promise<void> {
  await client.admin.deleteDocumentAttachment(documentId, attachmentId);
}

/** Proxy do GET ao API para servir bytes do anexo. */
export async function downloadDocumentAttachment(
  documentId: string,
  attachmentId: string,
): Promise<Response> {
  const upstream = await client.admin.downloadStream(
    `/documents/${documentId}/attachments/${attachmentId}`,
  );
  return proxyDownload(upstream, {
    errorPrefix: "Erro a obter anexo",
    fallbackDisposition: `inline; filename="anexo-${attachmentId}"`,
  });
}
