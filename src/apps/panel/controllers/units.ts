import { render } from "$panel/render.ts";
import { parseEurosToCents } from "$shared/money/parse_euros.ts";
import { parseFormString } from "$panel/libs/form_parsing.ts";
import { isOccupancyActive, splitOccupancies } from "$panel/libs/occupancy.ts";
import { client } from "$panel/client.ts";

export async function previewImport(file: File) {
  const previewResult = await client.admin.previewUnitsImport(file, file.name);

  // Junta ocupantes a cada fração via links, replicando a chave do parser
  // (email > nif > nome) para resolver occupantKey → ocupante.
  const occupants = previewResult.data.occupants as Array<{
    name: string;
    email: string | null;
    phone: string | null;
    nif: string | null;
    isDuplicate: boolean;
    existingName: string | null;
  }>;
  const links = previewResult.data.links as Array<{
    unitDesignation: string;
    occupantKey: string;
    relationshipType: string;
  }>;

  const occupantByKey = new Map<string, (typeof occupants)[number]>();
  for (const o of occupants) {
    const key = o.email
      ? `e:${o.email.toLowerCase()}`
      : o.nif
      ? `n:${o.nif}`
      : `name:${o.name.toLowerCase()}`;
    occupantByKey.set(key, o);
  }

  const occupantsByUnit = new Map<
    string,
    Array<(typeof occupants)[number] & { relationshipType: string }>
  >();
  for (const l of links) {
    const occ = occupantByKey.get(l.occupantKey);
    if (!occ) continue;
    const arr = occupantsByUnit.get(l.unitDesignation) ?? [];
    arr.push({ ...occ, relationshipType: l.relationshipType });
    occupantsByUnit.set(l.unitDesignation, arr);
  }

  // `identifier` com a mesma regra da stored column. Aqui
  // porque o preview ainda não gravou os dados no BD. "º" só em floor numérico
  // (pisos "R/C"/"S1" ficam literais).
  function computeIdentifier(
    u: { block?: unknown; floor?: unknown; door?: unknown; unitType?: unknown },
  ): string | null {
    const block = u.block ? String(u.block).trim() : "";
    const floorRaw = u.floor ? String(u.floor).trim() : "";
    const floor = floorRaw && /^\d+$/.test(floorRaw) ? `${floorRaw}º` : floorRaw;
    const door = u.door ? String(u.door).trim() : "";
    const isCommercial = u.unitType === "commercial";
    const content = isCommercial && door
      ? `Loja ${door}`
      : `${floor}${floor && door ? " " : ""}${door}`;
    const prefix = block ? `Bloco ${block}` : "";
    if (prefix && content) return `${prefix} - ${content}`;
    return prefix || content || null;
  }

  const unitsWithOccupants = (previewResult.data.units as Array<Record<string, unknown>>).map((
    u,
  ) => ({
    ...u,
    identifier: computeIdentifier(u),
    occupants: occupantsByUnit.get(String(u.designation)) ?? [],
  }));

  // Preview vem do parse do Excel (não passa pela API), por isso o sort fica
  // inline: length asc + alfabético = unitNaturalOrder do servidor.
  unitsWithOccupants.sort((a, b) => {
    const sa = String((a as Record<string, unknown>).designation ?? "");
    const sb = String((b as Record<string, unknown>).designation ?? "");
    if (sa.length !== sb.length) return sa.length - sb.length;
    return sa.localeCompare(sb, "pt", { sensitivity: "base" });
  });

  return await render("pages/units/import_preview.vto", {
    title: "Importar frações",
    section: "units",
    filename: previewResult.data.filename,
    units: unitsWithOccupants,
    occupants,
    links,
    warnings: previewResult.data.warnings,
    summary: previewResult.data.summary,
  });
}

export async function commitImport(form: Record<string, string | File>) {
  const payloadRaw = String(form.payload_json ?? "{}");
  let payload: {
    units: Array<Record<string, unknown>>;
    occupants: Array<Record<string, unknown>>;
    links: Array<Record<string, unknown>>;
  };
  try {
    payload = JSON.parse(payloadRaw);
  } catch {
    throw new Error("payload_json inválido");
  }
  const result = await client.admin.commitUnitsImport(payload);
  return result.data;
}

export async function listUnits(
  templatePath = "pages/units/list.vto",
  flash: { type: string; message: string } | null = null,
) {
  const unitsResult = await client.admin.listUnits();

  // `balance` agregado via view v_unit_balance. Dívida em dois buckets para a
  // UI: overdue (atraso real) e future (quotas lançadas mas não vencidas).
  // openDebtCents = overdue + future.
  const units = unitsResult.data.map((unit) => {
    const balance = (unit as unknown as {
      balance?: {
        openDebtCents: number;
        openCreditCents: number;
        overdueDebtCents: number;
        netCents: number;
      };
    }).balance ??
      { openDebtCents: 0, openCreditCents: 0, overdueDebtCents: 0, netCents: 0 };
    return {
      ...unit,
      occupants: unit.occupants ?? [],
      openDebtCents: balance.openDebtCents,
      overdueDebtCents: balance.overdueDebtCents,
      futureDebtCents: balance.openDebtCents - balance.overdueDebtCents,
      openCreditCents: balance.openCreditCents,
      netCents: balance.netCents,
    };
  });

  // listUnits já vem em ordem natural (unitNaturalOrder na API) - sem sort aqui.

  const occupantsTotal = units.reduce((s, u) => s + (u.occupants?.length ?? 0), 0);
  const unitsOverdue = units.filter((u) => u.overdueDebtCents > 0).length;
  const totalOverdueCents = units.reduce((s, u) => s + u.overdueDebtCents, 0);
  const totalFutureDebtCents = units.reduce((s, u) => s + u.futureDebtCents, 0);
  // Mantém totais agregados para back-compat e contexto.
  const unitsInDebt = units.filter((u) => u.openDebtCents > 0).length;
  const totalDebtCents = units.reduce((s, u) => s + u.openDebtCents, 0);

  // Guia de permilagem para o modal "+ Nova fração". Tudo em milésimos inteiros
  // para evitar floating-point noise (`1000 - 53.41` em IEEE 754 erra).
  const totalPmMicro = units.reduce(
    (s, u) => s + Math.round(Number(u.permillage ?? 0) * 1000),
    0,
  );
  const totalPm = totalPmMicro / 1000;
  const remaining = Math.max(0, 1_000_000 - totalPmMicro) / 1000;

  const html = await render(templatePath, {
    title: "Frações",
    section: "units",
    units,
    stats: {
      total: units.length,
      occupantsTotal,
      unitsInDebt,
      unitsOverdue,
      totalDebtCents,
      totalOverdueCents,
      totalFutureDebtCents,
    },
    totalPm,
    remaining,
    flash,
  });
  return html;
}

export async function getUnit(id: string) {
  const [unitResult, occupantsResult, usersResult] = await Promise.all([
    client.admin.getUnit(id),
    client.admin.listOccupants(),
    client.admin.listUsers().catch(() => ({ data: [] })),
  ]);

  const today = new Date().toISOString().slice(0, 10);
  const currentOccupantIds = new Set(
    (unitResult.data.occupants ?? [])
      .filter((o) => isOccupancyActive(o, today))
      .map((o) => o.occupantId),
  );
  const availableOccupants = occupantsResult.data.filter((o) => !currentOccupantIds.has(o.id));

  // Auditoria: createdBy/updatedBy/deletedBy vêm como { id, email, ip }; o
  // nome resolve-se via listUsers (fallback getUser) para o display.
  type ActorSnap = { id: string; email: string | null; ip: string | null };
  const unit = unitResult.data as typeof unitResult.data & {
    createdBy?: ActorSnap | null;
    updatedBy?: ActorSnap | null;
    deletedBy?: ActorSnap | null;
  };
  const userMap = new Map<string, string>(
    (usersResult.data ?? []).map((u) => [u.id, u.name]),
  );
  const actors = [unit.createdBy, unit.updatedBy, unit.deletedBy].filter(Boolean) as ActorSnap[];
  const missing = [...new Set(actors.map((a) => a.id))].filter((id) => !userMap.has(id));
  await Promise.all(missing.map(async (uid) => {
    try {
      const r = await client.admin.getUser(uid);
      userMap.set(uid, r.data.name);
    } catch {
      // keep raw id as fallback
    }
  }));
  const enrich = (a: ActorSnap | null | undefined) =>
    a ? { ...a, name: userMap.get(a.id) ?? a.id } : null;
  const audit = {
    createdBy: enrich(unit.createdBy),
    updatedBy: enrich(unit.updatedBy),
    deletedBy: enrich(unit.deletedBy),
  };

  const { active: activeOccupants, past: pastOccupants } = splitOccupancies(
    unitResult.data.occupants ?? [],
    today,
  );

  const html = await render("pages/units/edit.vto", {
    title: "Frações",
    section: "units",
    unit: { ...unitResult.data, occupants: unitResult.data.occupants ?? [] },
    unitId: id,
    activeOccupants,
    pastOccupants,
    availableOccupants,
    audit,
  });
  return html;
}

/**
 * Página de visualização da fração orientada ao dono: dívida, crédito, total
 * pago, ocupantes, charges e extrato bancário conciliado (via settlements).
 */
export async function showUnit(id: string, flash: { type: string; message: string } | null = null) {
  // listSettlements traz debitCharge/creditCharge/bankTransaction nested -
  // evita um listBankTransactions() só para resolver bankTx.description/date.
  const [unitResult, allChargesResult, allSettlementsResult, paymentPlansResult] = await Promise
    .all([
      client.admin.getUnit(id),
      client.admin.listCharges({ unitId: id }),
      client.admin.listSettlements(),
      client.admin.listPaymentPlans(id).catch(() => ({ data: [] })),
    ]);

  const unit = unitResult.data;
  const charges = allChargesResult.data;

  // Plano de pagamento (ADR 0039): 1 ativo + histórico terminal por baixo.
  const paymentPlans = paymentPlansResult.data ?? [];
  const activePaymentPlan = paymentPlans.find((p) => p.status === "active") ?? null;
  const paymentPlanHistory = paymentPlans.filter((p) => p.status !== "active");
  // Dica suave: meta planeada já passou mas o plano continua active (transições
  // são manuais - o end_date não expira nada, só sinaliza "rever").
  const todayISO = new Date().toISOString().slice(0, 10);
  const activePaymentPlanExpired = activePaymentPlan?.endDate
    ? activePaymentPlan.endDate < todayISO
    : false;

  // Balance agregado via view v_unit_balance (embebido em getUnit).
  // overdueDebtCents usa `due_date <= reconciled_through_date` (não `< today`):
  // só conta como vencido o que já era conciliável. Distinto do status 'overdue'
  // da charge (charge_status.ts usa `< today`). View: 016_vw_receipt_pending.sql.
  const unitBalance = (unit as unknown as {
    balance?: {
      openDebtCents: number;
      openCreditCents: number;
      overdueDebtCents: number;
      netCents: number;
    };
  }).balance ?? { openDebtCents: 0, openCreditCents: 0, overdueDebtCents: 0, netCents: 0 };
  const openDebtCents = unitBalance.openDebtCents;
  const overdueCents = unitBalance.overdueDebtCents;
  const futureDebtCents = openDebtCents - overdueCents;
  const creditBalanceCents = unitBalance.openCreditCents;

  // Settlements relevantes: unitId === this OU que envolvem charges desta unit.
  const chargeIds = new Set(charges.map((c) => c.id));
  const allSettlements = allSettlementsResult.data;
  const unitSettlements = allSettlements.filter((s) => {
    if (s.unitId === id) return true;
    if (s.debitChargeId && chargeIds.has(s.debitChargeId)) return true;
    if (s.creditChargeId && chargeIds.has(s.creditChargeId)) return true;
    return false;
  });

  // Enrich: nested vem direto do servidor via Drizzle `with`. Sem mapas locais.
  const enrichedSettlements = unitSettlements.map((s) => ({
    ...s,
    debit_charge_description: s.debitCharge?.description ?? null,
    debit_charge_type: s.debitCharge?.chargeType ?? null,
    credit_charge_description: s.creditCharge?.description ?? null,
    credit_charge_type: s.creditCharge?.chargeType ?? null,
    bank_tx_description: s.bankTransaction?.description ?? null,
    bank_tx_date: s.bankTransaction?.transactionDate ?? null,
  }));

  const { active: activeOccupants, past: pastOccupants } = splitOccupancies(
    unit.occupants ?? [],
    todayISO,
  );

  // Ordem cronológica ascendente (leitura de extrato): charge por competência,
  // settlement por settlement_date.
  const chargesAsc = [...charges].sort((a, b) => {
    const ka = String(a.competencePeriod ?? a.issueDate ?? "");
    const kb = String(b.competencePeriod ?? b.issueDate ?? "");
    if (ka !== kb) return ka.localeCompare(kb);
    return String(a.createdAt ?? "").localeCompare(String(b.createdAt ?? ""));
  });
  // ───────────────────────────────────────────────────────────────────────
  // Extrato bancário conciliado: agrupa bank_tx que tocaram esta fração (via
  // settlements bank_reconciliation), com quebra por charge. Ignora
  // charge_offset (compensação interna, sem entrada bancária).
  type BreakdownEntry = {
    chargeId: string;
    chargeDescription: string;
    chargeType: string;
    competencePeriod: string | null;
    amount: number;
    status: string;
  };
  type BankTxBreakdown = {
    bankTxId: string;
    transactionDate: string | null;
    description: string | null;
    bankAmount: number;
    totalAllocated: number;
    allocations: BreakdownEntry[];
    reversed: boolean;
  };
  const breakdownByTxId = new Map<string, BankTxBreakdown>();
  for (const s of unitSettlements) {
    if (s.settlementType !== "bank_reconciliation") continue;
    const txId = s.bankTransactionId;
    if (!txId) continue;
    const tx = s.bankTransaction;
    if (!tx) continue;
    const debitChargeId = s.debitChargeId;
    if (!debitChargeId) continue;
    const debitCharge = s.debitCharge;
    if (!debitCharge) continue;
    const entry: BreakdownEntry = {
      chargeId: debitChargeId,
      chargeDescription: debitCharge.description,
      chargeType: debitCharge.chargeType,
      // Truncado ao mês (o template formata por mês).
      competencePeriod: debitCharge.competencePeriod?.slice(0, 7) ?? null,
      amount: s.amount,
      status: s.status,
    };
    let bk = breakdownByTxId.get(txId);
    if (!bk) {
      bk = {
        bankTxId: txId,
        transactionDate: tx.transactionDate ?? null,
        description: tx.description ?? null,
        bankAmount: Number(tx.amount ?? 0),
        totalAllocated: 0,
        allocations: [],
        reversed: tx.status === "reversed" || tx.status === "ignored",
      };
      breakdownByTxId.set(txId, bk);
    }
    bk.allocations.push(entry);
    if (entry.status === "active") bk.totalAllocated += entry.amount;
  }
  const bankBreakdown = [...breakdownByTxId.values()].sort((a, b) =>
    String(a.transactionDate ?? "").localeCompare(String(b.transactionDate ?? ""))
  );

  // Estado + histórico do seguro + audit de emails desta fração (filtram por
  // unitId). `.catch` em cada um: dados secundários nunca rebentam a página.
  const [unitsStatusRes, insurancePoliciesRes, unitEmailsRes] = await Promise.all([
    client.admin.listInsuranceUnitsStatus({ unitId: id }).catch(() => ({ data: [] })),
    client.admin.listInsurancePolicies({ unitId: id }).catch(() => ({ data: [] })),
    client.admin.listUnitEmails(id).catch(() => ({ data: [] })),
  ]);
  const insuranceStatus = unitsStatusRes.data?.[0] ?? null;
  const insurancePolicies = insurancePoliciesRes.data ?? [];
  const unitEmails = unitEmailsRes.data ?? [];

  const html = await render("pages/units/show.vto", {
    title: `Fração ${unit.designation}`,
    section: "units",
    unit,
    unitId: id,
    activeOccupants,
    pastOccupants,
    charges: chargesAsc,
    bankBreakdown,
    insuranceStatus,
    insurancePolicies,
    unitEmails,
    activePaymentPlan,
    paymentPlanHistory,
    activePaymentPlanExpired,
    stats: {
      openDebtCents,
      creditBalanceCents,
      overdueCents,
      futureDebtCents,
      chargesCount: charges.length,
      settlementsCount: enrichedSettlements.length,
      bankBreakdownCount: bankBreakdown.length,
    },
    flash,
  });
  return html;
}

export async function createUnitManually(form: Record<string, string | File>) {
  const designation = parseFormString(form, "designation");
  if (!designation) throw new Error("Designação é obrigatória.");

  const permillageRaw = String(form.permillage ?? "").replace(",", ".").trim();
  const permillage = Number.parseFloat(permillageRaw);
  if (!Number.isFinite(permillage) || permillage <= 0 || permillage > 1000) {
    throw new Error("Permilagem inválida (entre 0,001 e 1000).");
  }

  const unitType = parseFormString(form, "unitType", { default: "residential" });
  if (unitType !== "residential" && unitType !== "commercial") {
    throw new Error("Tipo inválido.");
  }

  const strOrNull = (v: string | File | undefined) => {
    if (v === undefined) return null;
    const s = String(v).trim();
    return s === "" ? null : s;
  };

  const body: Record<string, unknown> = {
    designation,
    unitType: unitType,
    permillage,
    floor: strOrNull(form.floor),
    door: strOrNull(form.door),
    block: strOrNull(form.block),
    description: strOrNull(form.description),
  };

  const result = await client.admin.createUnitForMe(body);
  return { created: result.data };
}

export async function updateUnit(id: string, body: Record<string, string | File>) {
  await client.admin.updateUnitDescription(id, body);
  return { success: true };
}

/**
 * Atualiza as palavras-chave da pré-seleção da conciliação bancária. O form
 * envia um hidden `matchKeywords` (JSON array da UI de tags); aqui limpa + dedup.
 */
export async function updateUnitMatchKeywords(id: string, form: Record<string, string | File>) {
  const raw = String(form.matchKeywords ?? "[]");
  let kws: string[] = [];
  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) kws = parsed.map((x) => String(x ?? ""));
  } catch { /* fallback: [] */ }
  const cleaned = [...new Set(kws.map((s) => s.trim()).filter((s) => s.length > 0))];
  await client.admin.updateUnitDescription(id, { matchKeywords: cleaned });
  return { success: true };
}

export async function deleteUnit(id: string) {
  await client.admin.deleteUnit(id);
  return { success: true };
}

/** Deriva a competência (1º dia do mês) de uma data ISO: "2026-04-23" → "2026-04-01". */
function competenceFromIssueDate(issueDate: string): string | null {
  const m = issueDate.match(/^(\d{4})-(\d{2})-\d{2}$/);
  return m ? `${m[1]}-${m[2]}-01` : null;
}

export async function addChargeToUnit(unitId: string, form: Record<string, string | File>) {
  const amountCents = parseEurosToCents(form.amount) ?? 0;
  const issueDate = parseFormString(form, "issueDate");
  // Sem competencePeriod, deriva do issueDate (filtros/reports mensais).
  const formCompetence = parseFormString(form, "competencePeriod");
  const competencePeriod = formCompetence || competenceFromIssueDate(issueDate);
  await client.admin.createCharge({
    kind: "receivable",
    chargeType: parseFormString(form, "chargeType", { default: "opening_balance_debit" }),
    description: parseFormString(form, "description"),
    issueDate,
    dueDate: parseFormString(form, "dueDate", { emptyAsNull: true }),
    competencePeriod,
    amountCents,
    unitId: unitId,
  });
  return { ok: true };
}

/**
 * Adiciona um crédito (charge `kind=receivable, nature=credit`). O trigger
 * `fn_charge_ai` auto-compensa contra dívidas (charge_offset) e o remanescente
 * aguarda futuras charges. Casos: reembolso, adiantamento, ajuste.
 */
export async function addCreditToUnit(unitId: string, form: Record<string, string | File>) {
  const amountCents = parseEurosToCents(form.amount) ?? 0;
  const issueDate = parseFormString(form, "issueDate");
  await client.admin.createCharge({
    kind: "receivable",
    nature: "credit",
    chargeType: parseFormString(form, "chargeType", { default: "credit_adjustment" }),
    description: parseFormString(form, "description"),
    issueDate,
    competencePeriod: competenceFromIssueDate(issueDate),
    amountCents,
    unitId: unitId,
  });
  return { ok: true };
}

export async function addOccupantToUnit(
  unitId: string,
  occupantId: string,
  relationshipType: string,
) {
  await client.admin.createUnitOccupant(unitId, {
    unitId: unitId,
    occupantId: occupantId,
    relationshipType: relationshipType,
  });
  return { success: true };
}

export async function removeOccupantFromUnit(unitId: string, occupantId: string) {
  await client.admin.deleteUnitOccupantByOccupant(unitId, occupantId);
  return { success: true };
}

// ── Plano de pagamento (ADR 0039) ────────────────────────────────────────────

const PAYMENT_PLAN_TERMINAL = ["completed", "broken", "cancelled"] as const;

/** Nota partilhada (`notes`), nota interna e data final do form; pelo menos uma nota. */
function readPaymentPlanForm(form: Record<string, string | File>) {
  const notes = parseFormString(form, "notes") || null;
  const internalNotes = parseFormString(form, "internalNotes") || null;
  if (!notes && !internalNotes) {
    throw new Error("Preenche pelo menos uma das notas (partilhada ou interna).");
  }
  const endDate = parseFormString(form, "endDate", { emptyAsNull: true }) || null;
  return { notes, internalNotes, endDate };
}

export async function createUnitPaymentPlan(unitId: string, form: Record<string, string | File>) {
  await client.admin.createPaymentPlan(unitId, readPaymentPlanForm(form));
  return { ok: true };
}

export async function updateUnitPaymentPlan(
  unitId: string,
  planId: string,
  form: Record<string, string | File>,
) {
  await client.admin.updatePaymentPlan(unitId, planId, readPaymentPlanForm(form));
  return { ok: true };
}

export async function transitionUnitPaymentPlan(
  unitId: string,
  planId: string,
  status: string,
) {
  if (!(PAYMENT_PLAN_TERMINAL as readonly string[]).includes(status)) {
    throw new Error("Estado de plano inválido.");
  }
  await client.admin.updatePaymentPlan(unitId, planId, {
    status: status as "completed" | "broken" | "cancelled",
  });
  return { ok: true };
}
