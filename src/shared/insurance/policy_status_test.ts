import { assertEquals } from "@std/assert";
import {
  addOneYear,
  aggregateUnitStatus,
  approveRefusal,
  canAddAttachment,
  canDeletePolicy,
  canRejectPolicy,
  canRemoveAttachment,
  canRenew,
  canUndoRenewal,
  type ClassifiablePolicy,
  classifyPolicy,
  insuranceReminderCooldownEndsAt,
  isAdminDocumented,
  isInReminderCooldown,
  needsReminder,
  policyCapabilities,
  PRESUMED_EVIDENCE_GRACE_DAYS,
  presumedEvidenceGap,
  REMINDER_COOLDOWN_DAYS,
  reminderTriggerFor,
  RENEW_MAX_OVERDUE_DAYS,
  type RenewalPolicy,
  selectPolicyForDisplay,
  undoRenewalRefusal,
  unitUpdateAction,
} from "./policy_status.ts";

function policy(args: {
  id: string;
  status: string;
  validTo?: string | null;
  createdAt?: string;
}): ClassifiablePolicy & { id: string } {
  return {
    id: args.id,
    status: args.status,
    validTo: args.validTo ?? null,
    confirmedAt: null,
    createdAt: args.createdAt ?? "2024-01-01T00:00:00Z",
  };
}

Deno.test("selectPolicyForDisplay: array vazio → null", () => {
  assertEquals(selectPolicyForDisplay([]), null);
});

Deno.test("selectPolicyForDisplay: 1 policy → ela própria", () => {
  const p = policy({ id: "a", status: "active" });
  assertEquals(selectPolicyForDisplay([p])?.id, "a");
});

Deno.test("selectPolicyForDisplay: pending_review > active (caso da renovação)", () => {
  const active = policy({ id: "old", status: "active", validTo: "2027-01-01" });
  const pending = policy({ id: "new", status: "pending_review", validTo: "2028-01-01" });
  // Independentemente da ordem da entrada, pending vem primeiro.
  assertEquals(selectPolicyForDisplay([active, pending])?.id, "new");
  assertEquals(selectPolicyForDisplay([pending, active])?.id, "new");
});

Deno.test("selectPolicyForDisplay: active > rejected", () => {
  const rejected = policy({ id: "rej", status: "rejected", validTo: "2030-01-01" });
  const active = policy({ id: "act", status: "active", validTo: "2026-01-01" });
  assertEquals(selectPolicyForDisplay([rejected, active])?.id, "act");
});

Deno.test("selectPolicyForDisplay: tiebreaker valid_to DESC quando status igual", () => {
  const old = policy({ id: "a", status: "active", validTo: "2025-12-31" });
  const newer = policy({ id: "b", status: "active", validTo: "2027-06-30" });
  assertEquals(selectPolicyForDisplay([old, newer])?.id, "b");
});

Deno.test("selectPolicyForDisplay: validTo NULL fica para o fim (NULLS LAST)", () => {
  const noEnd = policy({ id: "x", status: "active", validTo: null });
  const withEnd = policy({ id: "y", status: "active", validTo: "2025-01-01" });
  assertEquals(selectPolicyForDisplay([noEnd, withEnd])?.id, "y");
});

Deno.test("selectPolicyForDisplay: tiebreaker final = createdAt DESC", () => {
  const earlier = policy({
    id: "e",
    status: "active",
    validTo: "2027-01-01",
    createdAt: "2024-01-01T00:00:00Z",
  });
  const later = policy({
    id: "l",
    status: "active",
    validTo: "2027-01-01",
    createdAt: "2024-06-01T00:00:00Z",
  });
  assertEquals(selectPolicyForDisplay([earlier, later])?.id, "l");
});

Deno.test("selectPolicyForDisplay: status desconhecido vai para o fim", () => {
  const weird = policy({ id: "w", status: "draft" /* não-canónico */ });
  const active = policy({ id: "a", status: "active" });
  assertEquals(selectPolicyForDisplay([weird, active])?.id, "a");
});

// ─── insuranceReminderCooldownEndsAt (ADR 0032) ───────────────────────────
// Seam fino sobre `cooldownEndsAt`; mesmo shape (Date | null) que billing/invite.

Deno.test("insuranceReminderCooldownEndsAt: null quando nunca houve lembrete", () => {
  assertEquals(insuranceReminderCooldownEndsAt(null), null);
});

Deno.test("insuranceReminderCooldownEndsAt: último lembrete + janela", () => {
  const last = new Date("2026-05-20T10:00:00Z");
  const end = insuranceReminderCooldownEndsAt(last);
  assertEquals(
    end?.getTime(),
    last.getTime() + REMINDER_COOLDOWN_DAYS * 86_400_000,
  );
});

Deno.test("insuranceReminderCooldownEndsAt: data inválida devolve null", () => {
  assertEquals(insuranceReminderCooldownEndsAt("não-é-data"), null);
});

// ─── isInReminderCooldown (ADR 0032) ──────────────────────────────────────
// WHY (Rule 9): mesmo gate que alimenta o 422, o filtro do bulk e o badge.
// Boundary exclusivo: no instante exato do fim da janela, já se pode reenviar.

const NOW = new Date("2026-05-20T10:00:00Z");
function daysBefore(n: number): Date {
  return new Date(NOW.getTime() - n * 86_400_000);
}

Deno.test("isInReminderCooldown: false quando nunca houve lembrete (null)", () => {
  assertEquals(isInReminderCooldown(null, NOW), false);
});

Deno.test("isInReminderCooldown: true dentro da janela", () => {
  assertEquals(isInReminderCooldown(daysBefore(REMINDER_COOLDOWN_DAYS - 1), NOW), true);
});

Deno.test("isInReminderCooldown: false no boundary exato (janela completa)", () => {
  // now === lastReminderAt + janela -> boundary exclusivo, já fora do cooldown.
  assertEquals(isInReminderCooldown(daysBefore(REMINDER_COOLDOWN_DAYS), NOW), false);
});

Deno.test("isInReminderCooldown: false depois da janela completa", () => {
  assertEquals(isInReminderCooldown(daysBefore(REMINDER_COOLDOWN_DAYS + 1), NOW), false);
});

Deno.test("isInReminderCooldown: aceita string ISO (vem do JSON da API)", () => {
  assertEquals(isInReminderCooldown(daysBefore(1).toISOString(), NOW), true);
});

// ─── Gates de ação (ADR 0040) ─────────────────────────────────────────────
// O discriminador de "vencida" é classifyPolicy (validTo vs hoje), não o status
// cru. Por isso todas as apólices vencidas abaixo têm status="active" na BD.

const TODAY = new Date("2026-06-20T00:00:00Z");

/** Data ISO a `days` de TODAY (negativo = passado). */
function isoFromToday(days: number): string {
  return new Date(TODAY.getTime() + days * 86_400_000).toISOString().slice(0, 10);
}

function pol(
  status: string,
  opts: {
    validTo?: string | null;
    confirmedAt?: string | null;
    evidenceSource?: "unit" | "admin" | null;
  } = {},
): ClassifiablePolicy {
  return {
    status,
    validTo: opts.validTo ?? null,
    confirmedAt: opts.confirmedAt ?? null,
    evidenceSource: opts.evidenceSource ?? null,
  };
}

// ─── canRenew ──────────────────────────────────────────────────────────────
// WHY: o admin tem de poder renovar precisamente as que estão em falha (vencidas
// há pouco), mas não criar uma vigência que já nasce vencida (> 1 ano).

Deno.test("canRenew: ativa (validTo no futuro) → true", () => {
  assertEquals(canRenew(pol("active", { validTo: isoFromToday(200) }), TODAY), true);
});

Deno.test("canRenew: a-expirar (dentro de 30d) → true", () => {
  assertEquals(canRenew(pol("active", { validTo: isoFromToday(10) }), TODAY), true);
});

Deno.test("canRenew: vencida há 100 dias → true (dentro da janela de 1 ano)", () => {
  assertEquals(canRenew(pol("active", { validTo: isoFromToday(-100) }), TODAY), true);
});

Deno.test("canRenew: vencida há exatamente 365 dias → true (limite inclusivo)", () => {
  // Limite: renovar aqui ainda é a última oportunidade de continuidade presumida.
  assertEquals(
    canRenew(pol("active", { validTo: isoFromToday(-RENEW_MAX_OVERDUE_DAYS) }), TODAY),
    true,
  );
});

Deno.test("canRenew: vencida há 366 dias → false (continuidade nasceria vencida)", () => {
  assertEquals(
    canRenew(pol("active", { validTo: isoFromToday(-(RENEW_MAX_OVERDUE_DAYS + 1)) }), TODAY),
    false,
  );
});

Deno.test("canRenew: superseded/rejected/pending nunca renovam", () => {
  assertEquals(canRenew(pol("superseded", { validTo: isoFromToday(200) }), TODAY), false);
  assertEquals(canRenew(pol("rejected", { validTo: isoFromToday(200) }), TODAY), false);
  assertEquals(canRenew(pol("pending_review", { validTo: isoFromToday(200) }), TODAY), false);
});

// ─── canAddAttachment ──────────────────────────────────────────────────────
// WHY: depois de vencer/ser substituída a apólice congela - o condómino é
// encaminhado a renovar, não a mexer no registo morto.

Deno.test("canAddAttachment: ativa presumida → true (carregar comprovativo)", () => {
  assertEquals(canAddAttachment(pol("active", { validTo: isoFromToday(200) }), TODAY), true);
});

Deno.test("canAddAttachment: pending_review (confirmada ou não) → true", () => {
  assertEquals(canAddAttachment(pol("pending_review"), TODAY), true);
  assertEquals(
    canAddAttachment(pol("pending_review", { confirmedAt: "2026-06-01T00:00:00Z" }), TODAY),
    true,
  );
});

Deno.test("canAddAttachment: rejeitada → true (corrigir e re-submeter)", () => {
  assertEquals(canAddAttachment(pol("rejected"), TODAY), true);
});

Deno.test("canAddAttachment: vencida → false (congelada)", () => {
  assertEquals(canAddAttachment(pol("active", { validTo: isoFromToday(-1) }), TODAY), false);
});

Deno.test("canAddAttachment: substituída → false (congelada)", () => {
  assertEquals(canAddAttachment(pol("superseded", { validTo: isoFromToday(200) }), TODAY), false);
});

// ─── canRemoveAttachment ───────────────────────────────────────────────────
// WHY: o condómino não pode despir a evidência de uma apólice já aprovada/ativa;
// só corrige enquanto monta a submissão (por confirmar) ou responde a rejeição.
// O admin não tem esta restrição.

Deno.test("canRemoveAttachment: condómino, por confirmar → true", () => {
  assertEquals(canRemoveAttachment(pol("pending_review"), TODAY, { isAdmin: false }), true);
});

Deno.test("canRemoveAttachment: condómino, confirmada (aguarda aprovação) → false", () => {
  assertEquals(
    canRemoveAttachment(
      pol("pending_review", { confirmedAt: "2026-06-01T00:00:00Z" }),
      TODAY,
      { isAdmin: false },
    ),
    false,
  );
});

Deno.test("canRemoveAttachment: condómino, rejeitada → true", () => {
  assertEquals(canRemoveAttachment(pol("rejected"), TODAY, { isAdmin: false }), true);
});

Deno.test("canRemoveAttachment: condómino, ativa → false (não despir evidência aprovada)", () => {
  assertEquals(
    canRemoveAttachment(pol("active", { validTo: isoFromToday(200) }), TODAY, { isAdmin: false }),
    false,
  );
});

Deno.test("canRemoveAttachment: admin → true em qualquer estado", () => {
  assertEquals(
    canRemoveAttachment(pol("active", { validTo: isoFromToday(200) }), TODAY, { isAdmin: true }),
    true,
  );
  assertEquals(
    canRemoveAttachment(pol("superseded", { validTo: isoFromToday(200) }), TODAY, {
      isAdmin: true,
    }),
    true,
  );
});

// ─── canDeletePolicy ───────────────────────────────────────────────────────
// WHY: o portal só limpa o próprio engano por confirmar; tudo o resto é da
// administração. O admin apaga registos sem cobertura viva, mas a cobertura
// saudável (ativa/a-expirar) exige rejeitar primeiro.

Deno.test("canDeletePolicy: portal, própria, por confirmar → true", () => {
  assertEquals(
    canDeletePolicy(pol("pending_review"), TODAY, { isAdmin: false, isOwnUpload: true }),
    true,
  );
});

Deno.test("canDeletePolicy: portal, própria mas já confirmada → false", () => {
  assertEquals(
    canDeletePolicy(
      pol("pending_review", { confirmedAt: "2026-06-01T00:00:00Z" }),
      TODAY,
      { isAdmin: false, isOwnUpload: true },
    ),
    false,
  );
});

Deno.test("canDeletePolicy: portal, por confirmar mas de outro uploader → false", () => {
  assertEquals(
    canDeletePolicy(pol("pending_review"), TODAY, { isAdmin: false, isOwnUpload: false }),
    false,
  );
});

Deno.test("canDeletePolicy: portal, ativa/vencida/rejeitada → false", () => {
  const ctx = { isAdmin: false, isOwnUpload: true };
  assertEquals(canDeletePolicy(pol("active", { validTo: isoFromToday(200) }), TODAY, ctx), false);
  assertEquals(canDeletePolicy(pol("active", { validTo: isoFromToday(-10) }), TODAY, ctx), false);
  assertEquals(canDeletePolicy(pol("rejected"), TODAY, ctx), false);
  assertEquals(
    canDeletePolicy(pol("superseded", { validTo: isoFromToday(200) }), TODAY, ctx),
    false,
  );
});

Deno.test("canDeletePolicy: admin, vencida → true (sem cobertura viva)", () => {
  assertEquals(
    canDeletePolicy(pol("active", { validTo: isoFromToday(-10) }), TODAY, { isAdmin: true }),
    true,
  );
});

Deno.test("canDeletePolicy: admin, substituída/rejeitada/por-rever → true", () => {
  const ctx = { isAdmin: true };
  assertEquals(
    canDeletePolicy(pol("superseded", { validTo: isoFromToday(200) }), TODAY, ctx),
    true,
  );
  assertEquals(canDeletePolicy(pol("rejected"), TODAY, ctx), true);
  assertEquals(canDeletePolicy(pol("pending_review"), TODAY, ctx), true);
});

Deno.test("canDeletePolicy: admin, ativa saudável → false (rejeitar primeiro)", () => {
  assertEquals(
    canDeletePolicy(pol("active", { validTo: isoFromToday(200) }), TODAY, { isAdmin: true }),
    false,
  );
});

Deno.test("canDeletePolicy: admin, a-expirar saudável → false (rejeitar primeiro)", () => {
  assertEquals(
    canDeletePolicy(pol("active", { validTo: isoFromToday(10) }), TODAY, { isAdmin: true }),
    false,
  );
});

// ─── aggregateUnitStatus ────────────────────────────────────────────────────
// WHY: o admin e o portal têm de responder o MESMO a "esta fração está coberta?".
// Antes o admin agregava (∃ active) e o portal usava a policy mais recente, e a
// mesma fração aparecia "Ativo" de um lado e "rejeitada" do outro (ADR 0017).

Deno.test("aggregateUnitStatus: active do proprietário vence rejected mais recente do inquilino", () => {
  const ativa = classifyPolicy(
    { ...pol("active", { validTo: isoFromToday(200) }), createdAt: "2026-01-01T00:00:00Z" },
    TODAY,
  );
  const rejeitada = classifyPolicy(
    { ...pol("rejected"), createdAt: "2026-06-01T00:00:00Z" },
    TODAY,
  );
  // A ordem de entrada não pode influenciar o resultado.
  assertEquals(aggregateUnitStatus([rejeitada, ativa]).kind, "active");
  assertEquals(aggregateUnitStatus([ativa, rejeitada]).kind, "active");
});

Deno.test("aggregateUnitStatus: devolve a policy que justifica o kind (não outra)", () => {
  // O par (kind, policy) tem de ser coerente - senão o badge diz "Ativo" e as
  // datas ao lado são as da rejeitada.
  const ativa = classifyPolicy(
    { ...pol("active", { validTo: isoFromToday(200) }), createdAt: "2026-01-01T00:00:00Z" },
    TODAY,
  );
  const rejeitada = classifyPolicy(
    { ...pol("rejected"), createdAt: "2026-06-01T00:00:00Z" },
    TODAY,
  );
  const agg = aggregateUnitStatus([rejeitada, ativa]);
  assertEquals("policy" in agg && agg.policy, ativa.kind === "active" ? ativa.policy : null);
});

Deno.test("aggregateUnitStatus: várias active desempata pela vigência mais longa", () => {
  const curta = classifyPolicy(
    { ...pol("active", { validTo: isoFromToday(60) }), createdAt: "2026-05-01T00:00:00Z" },
    TODAY,
  );
  const longa = classifyPolicy(
    { ...pol("active", { validTo: isoFromToday(300) }), createdAt: "2026-01-01T00:00:00Z" },
    TODAY,
  );
  const agg = aggregateUnitStatus([curta, longa]);
  assertEquals("policy" in agg && agg.policy.validTo, isoFromToday(300));
});

Deno.test("aggregateUnitStatus: só superseded → never_submitted (cobertura não é histórico)", () => {
  const antiga = classifyPolicy(pol("superseded", { validTo: isoFromToday(-10) }), TODAY);
  assertEquals(aggregateUnitStatus([antiga]).kind, "never_submitted");
});

Deno.test("aggregateUnitStatus: sem apólices → never_submitted", () => {
  assertEquals(aggregateUnitStatus([]).kind, "never_submitted");
});

// ─── policyCapabilities ────────────────────────────────────────────────────
// WHY: os templates passaram a consultar `can.*`; se o agregado deixar escapar
// uma ação que o handler recusa, a UI oferece botões que devolvem 422/403.

Deno.test("policyCapabilities: renovar e reabrir são só da administração", () => {
  const p = pol("active", { validTo: isoFromToday(200) });
  const admin = policyCapabilities(p, TODAY, { isAdmin: true });
  const condomino = policyCapabilities(p, TODAY, { isAdmin: false, isOwnUpload: true });
  assertEquals(admin.renew, true);
  assertEquals(admin.reopen, true);
  assertEquals(condomino.renew, false);
  assertEquals(condomino.reopen, false);
});

Deno.test("policyCapabilities: renovar é dos dois lados, por caminhos exclusivos", () => {
  // WHY: o admin renova presumindo (sem prova, com autoridade para aprovar); a
  // fração renova submetendo o recibo. Se ambos os gates abrissem para o mesmo
  // ator, a UI oferecia-lhe as duas portas para o mesmo ato.
  const p = pol("active", { validTo: isoFromToday(200) });
  const admin = policyCapabilities(p, TODAY, { isAdmin: true });
  const condomino = policyCapabilities(p, TODAY, { isAdmin: false, isOwnUpload: true });
  assertEquals(admin.submitRenewal, false);
  assertEquals(condomino.submitRenewal, true);

  // E a fração perde a porta exatamente onde o `canRenew` fecha.
  const velha = pol("active", { validTo: isoFromToday(-400) });
  assertEquals(
    policyCapabilities(velha, TODAY, { isAdmin: false, isOwnUpload: true }).submitRenewal,
    false,
  );
});

Deno.test("policyCapabilities: condómino só apaga a própria submissão por confirmar", () => {
  const draft = pol("pending_review");
  assertEquals(
    policyCapabilities(draft, TODAY, { isAdmin: false, isOwnUpload: true }).delete,
    true,
  );
  assertEquals(
    policyCapabilities(draft, TODAY, { isAdmin: false, isOwnUpload: false }).delete,
    false,
  );
});

Deno.test("policyCapabilities: editar segue a janela pending_review do ADR 0016", () => {
  assertEquals(policyCapabilities(pol("pending_review"), TODAY, { isAdmin: true }).edit, true);
  assertEquals(
    policyCapabilities(pol("active", { validTo: isoFromToday(200) }), TODAY, { isAdmin: true })
      .edit,
    false,
  );
});

// ─── undoRenewalRefusal / canUndoRenewal ───────────────────────────────────
// WHY: renovar por engano deixava a fração com uma `superseded` órfã que o
// agregado não conta - a cobertura documentada desaparecia e não havia caminho
// de volta. O undo só é seguro enquanto a renovação continua a ser uma presunção
// vazia; com comprovativo anexado, apagá-la levava o documento com ela.

/** Renovação presumida "acabada de criar": desfazível. */
function renovacao(over: Partial<RenewalPolicy> = {}): RenewalPolicy {
  return {
    status: "active",
    validTo: isoFromToday(300),
    renewedFromId: "p_anterior",
    presumedAt: "2026-06-19T00:00:00Z",
    attachmentCount: 0,
    ...over,
  };
}

Deno.test("canUndoRenewal: renovação presumida sem comprovativo → true", () => {
  assertEquals(undoRenewalRefusal(renovacao()), null);
  assertEquals(canUndoRenewal(renovacao()), true);
});

Deno.test("undoRenewalRefusal: apólice submetida pelo condómino → not_a_renewal", () => {
  // Sem `renewed_from_id` não há predecessor para restaurar - eliminar é o caminho.
  assertEquals(undoRenewalRefusal(renovacao({ renewedFromId: null })), "not_a_renewal");
});

Deno.test("undoRenewalRefusal: renovação que já recebeu evidência → not_presumed", () => {
  assertEquals(undoRenewalRefusal(renovacao({ presumedAt: null })), "not_presumed");
});

Deno.test("undoRenewalRefusal: renovação já substituída por outra → not_current", () => {
  // Desfazer no meio da cadeia partia a linhagem (o ON DELETE RESTRICT de `renewed_from_id`
  // recusaria na mesma, mas com 500 opaco).
  assertEquals(undoRenewalRefusal(renovacao({ status: "superseded" })), "not_current");
});

Deno.test("undoRenewalRefusal: comprovativo já anexado → has_evidence", () => {
  // O undo apaga a apólice; com um ficheiro lá dentro, apagava a evidência.
  assertEquals(undoRenewalRefusal(renovacao({ attachmentCount: 1 })), "has_evidence");
});

Deno.test("undoRenewalRefusal: contagem de anexos desconhecida → recusa (conservador)", () => {
  // O portal projeta apólices sem `attachmentCount`; sem saber, não afirmamos
  // que está vazia.
  assertEquals(undoRenewalRefusal(renovacao({ attachmentCount: undefined })), "has_evidence");
});

Deno.test("canUndoRenewal: renovação vencida continua desfazível", () => {
  // O predecessor está tão vencido como ela; desfazer não piora a cobertura e
  // devolve ao admin o registo real que a presunção tapou.
  assertEquals(canUndoRenewal(renovacao({ validTo: isoFromToday(-30) })), true);
});

Deno.test("policyCapabilities: desfazer renovação é só da administração", () => {
  const p = renovacao();
  assertEquals(policyCapabilities(p, TODAY, { isAdmin: true }).undoRenewal, true);
  assertEquals(
    policyCapabilities(p, TODAY, { isAdmin: false, isOwnUpload: true }).undoRenewal,
    false,
  );
});

// ─── presumedEvidenceGap ───────────────────────────────────────────────────
// WHY: o `renew` manual produz SEMPRE cobertura presumida sem evidência (ADR
// 0016). Sem alguém a perseguir o documento, essas frações ficavam marcadas como
// cobertas para sempre. Este predicado é a fonte do KPI, do filtro, do badge e
// dos alvos do bulk `renewal_evidence`.

Deno.test("presumedEvidenceGap: presumida sem ficheiros conta os dias desde a presunção", () => {
  const g = presumedEvidenceGap(
    renovacao({ presumedAt: new Date(TODAY.getTime() - 45 * 86_400_000) }),
    TODAY,
  );
  assertEquals(g?.days, 45);
  assertEquals(g?.overdue, true);
});

Deno.test("presumedEvidenceGap: dentro da tolerância não está em falta", () => {
  const g = presumedEvidenceGap(
    renovacao({
      presumedAt: new Date(TODAY.getTime() - PRESUMED_EVIDENCE_GRACE_DAYS * 86_400_000),
    }),
    TODAY,
  );
  assertEquals(g?.days, PRESUMED_EVIDENCE_GRACE_DAYS);
  assertEquals(g?.overdue, false);
});

Deno.test("presumedEvidenceGap: com comprovativo anexado → null (deixou de ser presunção)", () => {
  assertEquals(presumedEvidenceGap(renovacao({ attachmentCount: 2 }), TODAY), null);
});

Deno.test("presumedEvidenceGap: apólice submetida de raiz → null", () => {
  assertEquals(presumedEvidenceGap(renovacao({ presumedAt: null }), TODAY), null);
});

Deno.test("presumedEvidenceGap: presumida já substituída → null (não se persegue histórico)", () => {
  assertEquals(presumedEvidenceGap(renovacao({ status: "superseded" }), TODAY), null);
});

Deno.test("presumedEvidenceGap: documento entregue à administração fecha o alarme", () => {
  // É isto que faz o email deixar de sair: o admin já tem o papel na mão, pedi-lo
  // à condómina era pedir o que ele próprio recebeu.
  assertEquals(
    presumedEvidenceGap(renovacao({ evidenceSource: "admin", attachmentCount: 1 }), TODAY),
    null,
  );
});

Deno.test("presumedEvidenceGap: renovação presumida sem documento continua em falta", () => {
  // O caminho antigo (renovar sem anexo) não pode partir: `evidence_source` NULL
  // e zero anexos continuam a ser uma presunção por cobrir.
  const g = presumedEvidenceGap(
    renovacao({ evidenceSource: null, presumedAt: new Date(TODAY.getTime() - 45 * 86_400_000) }),
    TODAY,
  );
  assertEquals(g?.days, 45);
  assertEquals(g?.overdue, true);
});

// ─── isAdminDocumented ─────────────────────────────────────────────────────
// WHY: qualquer anexo cala o alarme de evidência, venha de quem vier. Sem uma
// marca explícita da origem, o sistema passava a afirmar que a fração documentou
// quando foi o administrador a receber o papel por email (ADR 0016).

Deno.test("isAdminDocumented: documento entregue à administração → true", () => {
  assertEquals(isAdminDocumented(renovacao({ evidenceSource: "admin", attachmentCount: 1 })), true);
});

Deno.test("isAdminDocumented: comprovativo submetido no portal pela fração → false", () => {
  // A distinção inteira: o mesmo anexo, origem diferente, badge diferente.
  assertEquals(isAdminDocumented(renovacao({ evidenceSource: "unit", attachmentCount: 1 })), false);
});

Deno.test("isAdminDocumented: marca sem ficheiro → false", () => {
  // Protege contra a marca ficar gravada e o documento ser apagado depois - a UI
  // afirmaria evidência que já não existe.
  assertEquals(
    isAdminDocumented(renovacao({ evidenceSource: "admin", attachmentCount: 0 })),
    false,
  );
});

Deno.test("isAdminDocumented: contagem de anexos desconhecida → false", () => {
  // O portal projeta apólices sem `attachmentCount`; não se afirma o que não se sabe.
  assertEquals(
    isAdminDocumented(renovacao({ evidenceSource: "admin", attachmentCount: undefined })),
    false,
  );
});

// ─── classifyPolicy: tabela base ───────────────────────────────────────────
// A classificação por vigência (não pelo status cru) é o discriminador que os
// gates, o agregado e os badges consomem. `validTo=null` já não é possível na
// BD (coluna NOT NULL) mas o classifier continua a defender-se dele.

Deno.test("classifyPolicy: sem apólice → never_submitted", () => {
  assertEquals(classifyPolicy(null, TODAY).kind, "never_submitted");
});

Deno.test("classifyPolicy: rejeitada → rejected_only", () => {
  assertEquals(classifyPolicy(pol("rejected"), TODAY).kind, "rejected_only");
});

Deno.test("classifyPolicy: ativa sem validTo → expired (defesa)", () => {
  const s = classifyPolicy(pol("active", { validTo: null }), TODAY);
  assertEquals(s.kind, "expired");
  if (s.kind === "expired") assertEquals(s.daysOverdue, 999);
});

Deno.test("classifyPolicy: ativa com vigência passada → expired com daysOverdue", () => {
  const s = classifyPolicy(pol("active", { validTo: isoFromToday(-2) }), TODAY);
  assertEquals(s.kind, "expired");
  if (s.kind === "expired") assertEquals(s.daysOverdue, 2);
});

Deno.test("classifyPolicy: ativa a expirar dentro da janela → expiring_soon", () => {
  const s = classifyPolicy(pol("active", { validTo: isoFromToday(12) }), TODAY);
  assertEquals(s.kind, "expiring_soon");
  if (s.kind === "expiring_soon") assertEquals(s.daysUntilExpiry, 12);
});

Deno.test("classifyPolicy: ativa para lá da janela → active", () => {
  assertEquals(classifyPolicy(pol("active", { validTo: isoFromToday(43) }), TODAY).kind, "active");
});

Deno.test("classifyPolicy: vigência acaba hoje → expiring_soon com 0 dias", () => {
  // Limite: 0 dias ainda é "a expirar"; abaixo de 0 passa a vencida.
  const s = classifyPolicy(pol("active", { validTo: isoFromToday(0) }), TODAY);
  assertEquals(s.kind, "expiring_soon");
  if (s.kind === "expiring_soon") assertEquals(s.daysUntilExpiry, 0);
});

// ─── classifyPolicy e a origem da evidência ────────────────────────────────
// WHY: `pending_review` sem `confirmedAt` significava sempre "aguarda condómino".
// No documento entregue à administração é o contrário (D3): a fração não confirma
// nada e quem tem de agir é o admin que o registou. O `kind` decide o rótulo, a
// aba do filtro, o agregado E os botões aprovar/rejeitar - com o rótulo errado o
// admin nunca via como fechar o registo que ele próprio criou.

Deno.test("classifyPolicy: documento da administração aguarda aprovação, não o condómino", () => {
  assertEquals(
    classifyPolicy(pol("pending_review", { evidenceSource: "admin" }), TODAY).kind,
    "awaiting_approval",
  );
});

Deno.test("classifyPolicy: submissão do portal por confirmar continua a aguardar o condómino", () => {
  // O caminho principal em produção não pode mudar: a fração submeteu e ainda
  // não confirmou os dados que o OCR extraiu.
  assertEquals(
    classifyPolicy(pol("pending_review", { evidenceSource: "unit" }), TODAY).kind,
    "awaiting_confirmation",
  );
  // Sem marca de origem (apólices antigas) idem.
  assertEquals(
    classifyPolicy(pol("pending_review"), TODAY).kind,
    "awaiting_confirmation",
  );
});

Deno.test("classifyPolicy: portal já confirmado continua a aguardar aprovação", () => {
  assertEquals(
    classifyPolicy(
      pol("pending_review", { evidenceSource: "unit", confirmedAt: "2026-06-01" }),
      TODAY,
    )
      .kind,
    "awaiting_approval",
  );
});

Deno.test("agregado: fração cujo único registo é o documento do admin conta como 'a aprovar'", () => {
  // O KPI e a aba "Aguarda condómino" contavam-na como estando à espera de
  // alguém que não tem nada a fazer.
  const doc = classifyPolicy(pol("pending_review", { evidenceSource: "admin" }), TODAY);
  assertEquals(aggregateUnitStatus([doc]).kind, "awaiting_approval");
});

// ─── addOneYear ────────────────────────────────────────────────────────────
// Vigência seguinte proposta pela renovação. Vive aqui (e não no módulo da API)
// porque o Panel pré-preenche o modal com ela e não pode importar de `$api/`.

Deno.test("addOneYear: data normal preserva dia/mês", () => {
  assertEquals(addOneYear("2025-05-03"), "2026-05-03");
  assertEquals(addOneYear("2026-12-31"), "2027-12-31");
  assertEquals(addOneYear("2025-01-01"), "2026-01-01");
});

Deno.test("addOneYear: 29 fev em ano bissexto → 28 fev no ano seguinte", () => {
  // 2025 não é bissexto: sem o recuo, Date daria 1 de março.
  assertEquals(addOneYear("2024-02-29"), "2025-02-28");
});

Deno.test("addOneYear: 28 fev sempre vira 28 fev (não promove para 29)", () => {
  // 2024 é bissexto, mas a vigência não ganha um dia por isso.
  assertEquals(addOneYear("2023-02-28"), "2024-02-28");
});

Deno.test("addOneYear: cruzar década/século", () => {
  assertEquals(addOneYear("2099-06-15"), "2100-06-15");
  assertEquals(addOneYear("1999-12-31"), "2000-12-31");
});

// ─── needsReminder ─────────────────────────────────────────────────────────
// WHY: a lista de alvos do bulk, o botão "Lembrar todos" e o badge derivam todos
// deste predicado. Se divergirem, o admin vê um botão que não manda nada (ou o
// contrário). O input é o kind AGREGADO da fração, não o da policy selecionada.

Deno.test("needsReminder: sem cobertura viva → true", () => {
  assertEquals(needsReminder("expired"), true);
  assertEquals(needsReminder("expiring_soon"), true);
  assertEquals(needsReminder("never_submitted"), true);
  assertEquals(needsReminder("rejected_only"), true);
});

Deno.test("needsReminder: coberta ou já em curso → false (não chatear quem cumpriu)", () => {
  assertEquals(needsReminder("active"), false);
  // Já submeteu: a bola está do lado da administração, não do condómino.
  assertEquals(needsReminder("awaiting_approval"), false);
  assertEquals(needsReminder("awaiting_confirmation"), false);
  assertEquals(needsReminder("superseded"), false);
});

// ─── reminderTriggerFor ────────────────────────────────────────────────────
// WHY: duas coisas diferentes podem faltar - o seguro ou só o comprovativo de
// uma renovação. Botão, copy do email e cooldown derivam todos deste predicado;
// se divergissem, o admin pedia o documento a quem não tem seguro nenhum (ou
// mandava "seguro em falta" a quem está coberto).

Deno.test("reminderTriggerFor: sem cobertura viva → lembrete de seguro em falta", () => {
  assertEquals(
    reminderTriggerFor({ aggregate: "expired", presumedEvidenceDays: null }),
    "individual",
  );
  assertEquals(
    reminderTriggerFor({ aggregate: "never_submitted", presumedEvidenceDays: null }),
    "individual",
  );
});

Deno.test("reminderTriggerFor: coberta por renovação sem comprovativo → pede o documento", () => {
  assertEquals(
    reminderTriggerFor({ aggregate: "active", presumedEvidenceDays: 12 }),
    "renewal_evidence",
  );
});

Deno.test("reminderTriggerFor: coberta e documentada → null (não há nada a pedir)", () => {
  assertEquals(reminderTriggerFor({ aggregate: "active", presumedEvidenceDays: null }), null);
  // Já submetida e à espera do admin: a bola está do lado da administração.
  assertEquals(
    reminderTriggerFor({ aggregate: "awaiting_approval", presumedEvidenceDays: null }),
    null,
  );
});

Deno.test("reminderTriggerFor: sem seguro vence a presunção (o buraco maior manda)", () => {
  // Renovação presumida que entretanto venceu: o que falta já não é o
  // comprovativo, é a cobertura.
  assertEquals(
    reminderTriggerFor({ aggregate: "expired", presumedEvidenceDays: 400 }),
    "individual",
  );
});

Deno.test("needsReminder: agregado 'active' cala o lembrete mesmo com pending ao lado", () => {
  // Fração com uma active do proprietário e uma pending do inquilino: o agregado
  // é "active". Usar o kind da policy selecionada mandaria email a quem já
  // está coberto - foi por isso que o predicado recebe o agregado.
  const ativa = classifyPolicy(pol("active", { validTo: isoFromToday(200) }), TODAY);
  const pendente = classifyPolicy(pol("pending_review", { confirmedAt: "2026-06-01" }), TODAY);
  assertEquals(needsReminder(aggregateUnitStatus([ativa, pendente]).kind), false);
});

// ─── canRejectPolicy ─────────────────────────────────────────────────────────
// O `reject` não tinha predicado nenhum - o handler fazia o UPDATE às cegas.

Deno.test("canRejectPolicy: pending_review e active sim, rejected e superseded não", () => {
  const casos: Array<[string, boolean, string]> = [
    ["pending_review", true, "fluxo normal do ADR 0016"],
    ["active", true, "é o 'rejeitar primeiro' que o ADR 0040 exige antes de apagar"],
    ["rejected", false, "rejeitar outra vez reescrevia a razão original"],
    ["superseded", false, "histórico fechado"],
  ];
  for (const [status, esperado, porque] of casos) {
    assertEquals(canRejectPolicy({ status }), esperado, `${status}: ${porque}`);
  }
});

Deno.test("canRejectPolicy: uma vencida continua rejeitável (na BD ainda é 'active')", () => {
  // Status cru de propósito, como `canReopen`: o discriminador de vencida é o
  // `classifyPolicy`, mas para rejeitar o que conta é a linha estar viva.
  assertEquals(canRejectPolicy({ status: "active", validTo: "2020-01-01" }), true);
});

// ─── approveRefusal ──────────────────────────────────────────────────────────

Deno.test("approveRefusal: só de pending_review", () => {
  assertEquals(approveRefusal({ status: "active", confirmedAt: "2026-01-01" }), "not_pending");
  assertEquals(approveRefusal({ status: "rejected", confirmedAt: "2026-01-01" }), "not_pending");
  assertEquals(approveRefusal({ status: "superseded", confirmedAt: "2026-01-01" }), "not_pending");
});

Deno.test("approveRefusal: a submissão da fração espera a confirmação dela", () => {
  assertEquals(approveRefusal({ status: "pending_review", confirmedAt: null }), "unconfirmed");
  assertEquals(
    approveRefusal({ status: "pending_review", confirmedAt: null, evidenceSource: "unit" }),
    "unconfirmed",
  );
  assertEquals(approveRefusal({ status: "pending_review", confirmedAt: "2026-01-01" }), null);
});

Deno.test("approveRefusal: o documento entregue à administração não espera ninguém", () => {
  // Não há segundo interveniente (ADR 0016): o admin verifica o que
  // o OCR extraiu e aprova no mesmo ato. Sem isto o caminho ficava encravado.
  assertEquals(
    approveRefusal({ status: "pending_review", confirmedAt: null, evidenceSource: "admin" }),
    null,
  );
});

// ─── unitUpdateAction ("Atualizar" da lista de seguros) ──────────────────────
// WHY: o admin atualiza o seguro a partir da lista, sem entrar na fração. O botão
// tem de levar ao caminho certo: renovar quando há de onde (linhagem), registar
// de raiz quando não há, e nunca empilhar outra submissão sobre uma por rever.

Deno.test("unitUpdateAction: fração sem apólices → registar", () => {
  assertEquals(unitUpdateAction([], TODAY), { kind: "register" });
});

Deno.test("unitUpdateAction: ativa → renovar essa apólice", () => {
  const ativa = { ...pol("active", { validTo: isoFromToday(200) }), id: "a" };
  assertEquals(unitUpdateAction([ativa], TODAY), { kind: "renew", policy: ativa });
});

Deno.test("unitUpdateAction: vencida dentro da janela → renovar", () => {
  const vencida = { ...pol("active", { validTo: isoFromToday(-100) }), id: "v" };
  assertEquals(unitUpdateAction([vencida], TODAY).kind, "renew");
});

Deno.test("unitUpdateAction: vencida há mais de 1 ano → registar (renovar nasceria vencida)", () => {
  const velha = pol("active", { validTo: isoFromToday(-(RENEW_MAX_OVERDUE_DAYS + 1)) });
  assertEquals(unitUpdateAction([velha], TODAY), { kind: "register" });
});

Deno.test("unitUpdateAction: só rejeitada (e substituída) → registar", () => {
  const out = unitUpdateAction([
    pol("rejected", { validTo: isoFromToday(200) }),
    pol("superseded", { validTo: isoFromToday(-10) }),
  ], TODAY);
  assertEquals(out, { kind: "register" });
});

Deno.test("unitUpdateAction: há uma por rever → rever, mesmo com ativa renovável", () => {
  // Renovar por cima de uma renovação pendente dá 409; registar duplicava-a.
  const out = unitUpdateAction([
    pol("active", { validTo: isoFromToday(200) }),
    pol("pending_review", { validTo: isoFromToday(565) }),
  ], TODAY);
  assertEquals(out, { kind: "review" });
});

Deno.test("unitUpdateAction: várias renováveis → a de validade mais longa", () => {
  const curta = { ...pol("active", { validTo: isoFromToday(20) }), id: "curta" };
  const longa = { ...pol("active", { validTo: isoFromToday(300) }), id: "longa" };
  const out = unitUpdateAction([curta, longa], TODAY);
  assertEquals(out.kind === "renew" ? (out.policy as { id: string }).id : out.kind, "longa");
});
