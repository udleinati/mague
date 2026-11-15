import { render } from "$panel/render.ts";
import { type Occupant, type Unit } from "$shared/client/mod.ts";
import { currentCondominiumId } from "$panel/context.ts";
import { parseFormBool, parseFormString } from "$panel/libs/form_parsing.ts";
import { isOccupancyActive } from "$panel/libs/occupancy.ts";
import { client } from "$panel/client.ts";

interface UnitWithOccupants extends Unit {
  occupants: Array<{
    id: string;
    occupantId: string;
    relationshipType: string;
    startDate: string;
    endDate: string | null;
    createdAt: string;
    occupant: {
      id: string;
      name: string;
      email: string | null;
      phone: string | null;
      nif: string | null;
    };
  }>;
}

export async function listOccupants(filter?: string) {
  const [unitsResult, occupantsResult] = await Promise.all([
    client.admin.listUnits() as unknown as Promise<{ data: UnitWithOccupants[]; status: number }>,
    client.admin.listOccupants(),
  ]);

  // Filtro any-match: ocupante entra se PELO MENOS UMA ligação ativa bate o
  // `relationship_type` pedido; a tabela mostra sempre TODAS as ligações - ADR 0018.
  const occupantMap: {
    occupant: Occupant;
    units: { unit: UnitWithOccupants; startDate: string; relationshipType: string }[];
  }[] = [];

  const today = new Date().toISOString().slice(0, 10);
  for (const unit of unitsResult.data) {
    for (const unitOccupant of unit.occupants ?? []) {
      if (!isOccupancyActive(unitOccupant, today)) continue;

      const occupant = occupantsResult.data.find((o) => o.id === unitOccupant.occupantId);
      if (!occupant) continue;

      const existing = occupantMap.find((e) => e.occupant.id === occupant.id);
      if (existing) {
        existing.units.push({
          unit,
          startDate: unitOccupant.startDate,
          relationshipType: unitOccupant.relationshipType,
        });
      } else {
        occupantMap.push({
          occupant,
          units: [{
            unit,
            startDate: unitOccupant.startDate,
            relationshipType: unitOccupant.relationshipType,
          }],
        });
      }
    }
  }

  // Orfãos (sem ligações ativas) só aparecem sem filtro - não têm relação para comparar.
  const filtered = filter
    ? occupantMap.filter((e) => e.units.some((u) => u.relationshipType === filter))
    : occupantMap;

  if (!filter) {
    for (const occupant of occupantsResult.data) {
      if (filtered.some((e) => e.occupant.id === occupant.id)) continue;
      filtered.push({ occupant, units: [] });
    }
  }

  // Zero sort: `listUnits` (natural order) + `unitOccupants` (por start_date)
  // já constroem o `occupantMap` ordenado; orfãos entram a seguir por nome
  // (`listOccupants` devolve `asc(name)`).

  const html = await render("pages/occupants/list.vto", {
    title: "Ocupantes",
    section: "occupants",
    occupantMap: filtered,
    filter,
  });
  return html;
}

export async function getOccupant(occupantId: string) {
  const [unitsResult, occupantResult, occupantEmailsResult] = await Promise.all([
    client.admin.listUnits() as unknown as Promise<{ data: UnitWithOccupants[]; status: number }>,
    client.admin.getOccupant(occupantId),
    // Audit de emails: dado secundário, nunca rebenta a página.
    client.admin.listOccupantEmails(occupantId).catch(() => ({ data: [] })),
  ]);

  // Captura `id` + `relationshipType` do unit_occupant - precisos no
  // modal de edição da associação (PATCH /units/:unitId/occupants/:id).
  const occupantUnits: {
    unit: UnitWithOccupants;
    unitOccupantId: string;
    relationshipType: string;
    startDate: string;
    endDate: string | null;
  }[] = [];
  const pastOccupantUnits: typeof occupantUnits = [];
  const linkedUnitIds = new Set<string>();

  const today = new Date().toISOString().slice(0, 10);
  for (const unit of unitsResult.data) {
    for (const uo of unit.occupants ?? []) {
      if (uo.occupantId !== occupantId) continue;
      const entry = {
        unit,
        unitOccupantId: uo.id,
        relationshipType: uo.relationshipType,
        startDate: uo.startDate,
        endDate: uo.endDate ?? null,
      };
      // Uma associação terminada continua listada (em "anteriores") para poder
      // ser corrigida - só deixa de bloquear a fração para nova associação.
      if (isOccupancyActive(uo, today)) {
        occupantUnits.push(entry);
        linkedUnitIds.add(unit.id);
      } else {
        pastOccupantUnits.push(entry);
      }
    }
  }

  // Zero sort: `availableUnits` é só um filter que preserva a ordem natural da API.
  const availableUnits = unitsResult.data.filter((u) => !linkedUnitIds.has(u.id));

  const html = await render("pages/occupants/show.vto", {
    title: occupantResult.data.name,
    section: "occupants",
    occupant: {
      occupantId,
      occupantName: occupantResult.data.name,
      occupantData: occupantResult.data,
      units: occupantUnits,
      pastUnits: pastOccupantUnits,
    },
    availableUnits,
    occupantEmails: occupantEmailsResult.data ?? [],
  });
  return html;
}

export async function updateOccupant(occupantId: string, form: Record<string, string>) {
  const body: Record<string, unknown> = {};

  if (form.name) body.name = form.name;
  if (form.email) body.email = form.email || null;
  if (form.phone) body.phone = form.phone || null;
  if (form.nif) body.nif = form.nif || null;
  if (form.personType) body.personType = form.personType;
  // Checkbox hidden `off` + `on`: distingue "ausente do form" de "desligado".
  if (form.receiveReceiptEmails !== undefined) {
    body.receiveReceiptEmails = parseFormBool(form, "receiveReceiptEmails");
  }

  await client.admin.updateOccupant(occupantId, body);
  return { success: true };
}

export async function createOccupant(form: Record<string, string>) {
  const name = form.name?.trim();
  if (!name) return { error: "Nome é obrigatório" };

  const body: Record<string, unknown> = { name };

  if (form.email) body.email = form.email;
  if (form.phone) body.phone = form.phone;
  if (form.nif) body.nif = form.nif;
  if (form.personType) body.personType = form.personType;

  const created = await client.admin.createOccupant(body);
  return { created: created.data };
}

export async function removeUnitOccupant(occupantId: string, unitId: string) {
  await client.admin.deleteUnitOccupantByOccupant(unitId, occupantId);
  return { success: true };
}

/** `endDate` vazio é interpretado como null (= associação ainda ativa). */
export async function updateUnitOccupant(
  unitId: string,
  unitOccupantId: string,
  form: Record<string, string | File>,
) {
  const body: Record<string, unknown> = {};
  if (form.relationshipType !== undefined) {
    body.relationshipType = String(form.relationshipType);
  }
  if (form.startDate !== undefined) {
    const v = parseFormString(form, "startDate");
    if (v) body.startDate = v;
  }
  if (form.endDate !== undefined) {
    body.endDate = parseFormString(form, "endDate", { emptyAsNull: true });
  }
  await client.admin.updateUnitOccupant(unitId, unitOccupantId, body);
  return { success: true };
}

/** POST /occupants/:occId/invite (HX-Request) - envia/re-envia convite e
 *  devolve OOB swap da célula "Portal" + toast. Sem reload. */
export async function inviteOccupantHtmx(occupantId: string) {
  const cid = currentCondominiumId();

  // Re-fetch no fim para apanhar `userId` atualizado (se foi criado agora).
  let toastType: "success" | "error" = "success";
  let toastMsg = "";
  try {
    const { data } = await client.admin.inviteOccupant(occupantId);
    toastMsg = `Convite enviado para ${data.sentTo ?? "o ocupante"}.`;
  } catch (e) {
    toastType = "error";
    toastMsg = (e as Error).message;
  }

  const occupantRes = await client.admin.getOccupant(occupantId).catch(() => null);
  const occupant = occupantRes?.data ?? null;
  const [partialHtml, toastHtml] = await Promise.all([
    occupant
      ? render("partials/occupant_portal_status.vto", {
        occupant,
        currentCondominiumId: cid,
      })
      : Promise.resolve(""),
    render("pages/reconciliation/_toast.vto", {
      toast: { type: toastType, message: toastMsg },
    }),
  ]);
  return partialHtml + toastHtml;
}

export async function deleteOccupant(occupantId: string) {
  // Cascade das ligações vive no handler API (1 transação); o panel é wrapper fino.
  await client.admin.deleteOccupant(occupantId);
  return { success: true };
}
