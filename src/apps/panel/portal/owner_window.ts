// Janela temporal "como owner" do user numa unit. Filtra tudo o que o portal
// mostra para o owner só ver o seu período. Regra de domínio do portal (não da
// API): depende do user logged + occupants dele; endpoint dedicado seria
// over-engineering até haver 2º consumidor.

export interface OwnerWindow {
  startDate: string; // YYYY-MM-DD inclusive
  endDate: string | null; // YYYY-MM-DD inclusive ou null = sem fim
  occupantName: string;
  /** true se admin a ver "como" owner (sem ser ele); false para owner real. */
  isImpersonatedView: boolean;
}

export interface NestedOccupantUO {
  relationshipType: string;
  startDate: string;
  endDate: string | null;
  occupant: { id: string; name: string; userId: string | null };
}

interface CurrentUser {
  id: string;
  role: string;
}

/** Relações que contam como "janela própria". `tenant` fica de fora - mesmo
 *  tratamento das comunicações financeiras (CONTEXT.md). */
const SELF_WINDOW_RELATIONSHIPS = new Set(["owner", "resident"]);

// Janela temporal da relação do user com a unit (pure). Resolução:
//   1. User com ligação própria owner/resident → a SUA janela (match por
//      userId, ignora role: admin/super pode ser condómino).
//   2. Senão → owner ativo mais recente (start desc).
//   3. Sem owner ativo → último owner terminado (end_date desc).
//   4. Sem owners → null.
export function resolveOwnerWindow(
  occupants: NestedOccupantUO[],
  user: CurrentUser | null,
): OwnerWindow | null {
  if (user) {
    const mine = occupants.find(
      (uo) =>
        uo.occupant.userId === user.id &&
        SELF_WINDOW_RELATIONSHIPS.has(uo.relationshipType),
    );
    if (mine) {
      return {
        startDate: String(mine.startDate),
        endDate: mine.endDate ? String(mine.endDate) : null,
        occupantName: mine.occupant.name,
        isImpersonatedView: false,
      };
    }
  }

  // Impersonate sem ligação própria: janela do proprietário (responsabilidade
  // legal/financeira da fração).
  const owners = occupants.filter((uo) => uo.relationshipType === "owner");
  if (owners.length === 0) return null;

  const active = owners
    .filter((uo) => !uo.endDate)
    .sort((a, b) => String(b.startDate).localeCompare(String(a.startDate)));
  if (active.length > 0) {
    const top = active[0];
    return {
      startDate: String(top.startDate),
      endDate: null,
      occupantName: top.occupant.name,
      isImpersonatedView: true,
    };
  }

  const ended = [...owners].sort((a, b) =>
    String(b.endDate ?? "9999").localeCompare(String(a.endDate ?? "9999"))
  );
  const last = ended[0];
  return {
    startDate: String(last.startDate),
    endDate: last.endDate ? String(last.endDate) : null,
    occupantName: last.occupant.name,
    isImpersonatedView: true,
  };
}

// `date` dentro da janela? Sem janela → true (sem filtro); sem data → false.
export function isInOwnerWindow(
  date: string | null | undefined,
  window_: OwnerWindow | null,
): boolean {
  if (!window_) return true;
  if (!date) return false;
  const d = String(date);
  if (d < window_.startDate) return false;
  if (window_.endDate && d > window_.endDate) return false;
  return true;
}

interface ChargeForWindow {
  competencePeriod?: string | null;
  issueDate?: string | null;
}

// Filtra charges pela janela. Usa `competencePeriod`, senão `issueDate`;
// sem nenhuma data → saem (isInOwnerWindow é false para null).
export function filterChargesByWindow<T extends ChargeForWindow>(
  charges: readonly T[],
  window_: OwnerWindow | null,
): T[] {
  return charges.filter((c) => isInOwnerWindow(c.competencePeriod ?? c.issueDate ?? null, window_));
}

interface SettlementForWindow {
  unitId?: string | null;
  debitChargeId?: string | null;
  creditChargeId?: string | null;
  settlementDate: string;
  bankTransaction?: { transactionDate?: string | null } | null;
}

// Filtra settlements que tocam a unit (direta ou via `chargeIds`, as charges
// já filtradas) E caem na janela. Data do bank_tx se houver, senão settlementDate.
export function filterSettlementsByWindow<T extends SettlementForWindow>(
  settlements: readonly T[],
  chargeIds: ReadonlySet<string>,
  unitId: string,
  window_: OwnerWindow | null,
): T[] {
  return settlements.filter((s) => {
    const touchesUnit = s.unitId === unitId ||
      (typeof s.debitChargeId === "string" && chargeIds.has(s.debitChargeId)) ||
      (typeof s.creditChargeId === "string" && chargeIds.has(s.creditChargeId));
    if (!touchesUnit) return false;
    const date = s.bankTransaction?.transactionDate ?? s.settlementDate;
    return isInOwnerWindow(date, window_);
  });
}
