import { render } from "$panel/render.ts";
import { client } from "$panel/client.ts";
import { requireCurrentCondominium } from "$panel/condominium.ts";
import { parseFormInt, parseFormString } from "$panel/libs/form_parsing.ts";

export async function listCondominiums() {
  const result = await client.super.listCondominiums();

  const html = await render("pages/condominiums/list.vto", {
    title: "Condomínios",
    section: "condominiums",
    condominiums: result.data,
  });
  return html;
}

export async function newCondominiumPage() {
  return await render("pages/condominiums/new.vto", {
    title: "Novo condomínio",
    section: "condominiums",
  });
}

export async function createCondominium(form: Record<string, string | File>) {
  const result = await client.super.createCondominium({
    name: parseFormString(form, "name"),
    designationType: parseFormString(form, "designationType") === "building"
      ? "building"
      : "condominium",
    email: parseFormString(form, "email", { emptyAsNull: true }),
    fiscalNumber: parseFormString(form, "fiscalNumber", { emptyAsNull: true }),
    address: parseFormString(form, "address", { emptyAsNull: true }),
    city: parseFormString(form, "city", { emptyAsNull: true }),
    postalCode: parseFormString(form, "postalCode", { emptyAsNull: true }),
    quotaDayOfMonth: parseFormInt(form, "quotaDayOfMonth", { default: 1 }),
  });
  return result.data;
}

export async function getCondominium(
  id: string,
  flash: { type: string; message: string } | null = null,
) {
  const [condoResult, currentCondominium] = await Promise.all([
    client.super.getCondominium(id),
    requireCurrentCondominium(),
  ]);

  const html = await render("pages/condominiums/show.vto", {
    title: condoResult.data.name,
    section: "condominiums",
    target: condoResult.data,
    currentCondominium,
    flash,
  });
  return html;
}

export async function getEditCondominium(
  id: string,
  flash: { type: string; message: string } | null = null,
) {
  const [condoResult, currentCondominium] = await Promise.all([
    client.super.getCondominium(id),
    requireCurrentCondominium(),
  ]);
  return await render("pages/condominiums/edit.vto", {
    title: `Editar ${condoResult.data.name}`,
    section: "condominiums",
    target: condoResult.data,
    currentCondominium,
    flash,
  });
}

export async function updateCondominium(id: string, form: Record<string, string | File>) {
  const body: Record<string, unknown> = {};
  const strOrNull = (v: string | File | undefined) => {
    if (v === undefined) return undefined;
    const s = String(v).trim();
    return s === "" ? null : s;
  };
  if (form.name !== undefined) body.name = String(form.name).trim();
  if (form.designationType !== undefined) {
    const v = String(form.designationType).trim();
    if (v === "building" || v === "condominium") body.designationType = v;
  }
  if (form.email !== undefined) body.email = strOrNull(form.email);
  if (form.bccEmail !== undefined) body.bccEmail = strOrNull(form.bccEmail);
  if (form.replyToEmail !== undefined) body.replyToEmail = strOrNull(form.replyToEmail);
  if (form.fiscalNumber !== undefined) body.fiscalNumber = strOrNull(form.fiscalNumber);
  if (form.address !== undefined) body.address = strOrNull(form.address);
  if (form.city !== undefined) body.city = strOrNull(form.city);
  if (form.postalCode !== undefined) body.postalCode = strOrNull(form.postalCode);
  if (form.quotaDayOfMonth !== undefined) {
    const n = parseInt(String(form.quotaDayOfMonth), 10);
    if (!isNaN(n)) body.quotaDayOfMonth = n;
  }
  await client.super.updateCondominium(id, body);
  return { ok: true };
}
