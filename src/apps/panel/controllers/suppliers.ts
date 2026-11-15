import { render } from "$panel/render.ts";
import { parseFormString } from "$panel/libs/form_parsing.ts";
import { client } from "$panel/client.ts";

export async function listSuppliers() {
  const suppliers = await client.admin.listSuppliers();

  return await render("pages/suppliers/list.vto", {
    title: "Fornecedores",
    section: "suppliers",
    suppliers: suppliers.data,
  });
}

// Parse + clean do hidden `matchKeywords` (JSON string vindo da UI de tags).
function parseMatchKeywords(raw: string | File | undefined): string[] {
  const s = typeof raw === "string" ? raw : "[]";
  let list: string[] = [];
  try {
    const parsed = JSON.parse(s);
    if (Array.isArray(parsed)) list = parsed.map((x) => String(x ?? ""));
  } catch { /* fallback: [] */ }
  return [...new Set(list.map((v) => v.trim()).filter((v) => v.length > 0))];
}

export async function createSupplier(form: Record<string, string | File>) {
  await client.admin.createSupplier({
    name: parseFormString(form, "name"),
    nif: parseFormString(form, "nif", { emptyAsNull: true }),
    contactName: parseFormString(form, "contactName", { emptyAsNull: true }),
    contactEmail: parseFormString(form, "contactEmail", { emptyAsNull: true }),
    contactPhone: parseFormString(form, "contactPhone", { emptyAsNull: true }),
    notes: parseFormString(form, "notes", { emptyAsNull: true }),
    matchKeywords: parseMatchKeywords(form.matchKeywords),
  });
  return { ok: true };
}

export async function updateSupplier(
  supplierId: string,
  form: Record<string, string | File>,
) {
  await client.admin.updateSupplier(supplierId, {
    name: parseFormString(form, "name"),
    nif: parseFormString(form, "nif", { emptyAsNull: true }),
    contactName: parseFormString(form, "contactName", { emptyAsNull: true }),
    contactEmail: parseFormString(form, "contactEmail", { emptyAsNull: true }),
    contactPhone: parseFormString(form, "contactPhone", { emptyAsNull: true }),
    notes: parseFormString(form, "notes", { emptyAsNull: true }),
    matchKeywords: parseMatchKeywords(form.matchKeywords),
  });
  return { ok: true };
}

export async function deleteSupplier(supplierId: string) {
  await client.admin.deleteSupplier(supplierId);
  return { ok: true };
}
