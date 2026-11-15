// Defaults inferidos para `createCharge` (pure functions). Centralizados na API
// para que todos os consumers (panel, mobile, scripts) usem a mesma regra. O
// ponto de entrada é `normalizeChargeInput` - defaults + validação num só passo.

import { STATUS_CODE } from "@std/http";
import { AppError } from "$api/libs/error/app_error.ts";

export interface ChargeCreateRawInput {
  kind: "receivable" | "payable";
  nature?: "debit" | "credit" | null;
  chargeType?: string | null;
  competencePeriod?: string | null;
  issueDate: string;
  supplierId?: string | null;
}

export interface ChargeCreateNormalizedInput {
  nature: "debit" | "credit";
  chargeType: string;
  competencePeriod: string;
}

// Atira AppError 400 se `competencePeriod` ficar a null (e.g. issueDate inválido).
export function normalizeChargeInput(
  raw: ChargeCreateRawInput,
): ChargeCreateNormalizedInput {
  const nature = raw.nature ?? "debit";
  const chargeType = raw.chargeType ??
    inferChargeType({ kind: raw.kind, supplierId: raw.supplierId });
  const competencePeriod = raw.competencePeriod ??
    deriveCompetenceFromIssueDate(raw.issueDate);
  if (!competencePeriod) {
    throw new AppError({
      message:
        "competencePeriod obrigatório (ou issueDate em formato YYYY-MM-DD para derivação automática)",
      statusCode: STATUS_CODE.BadRequest,
      code: "VALIDATION_ERROR",
    });
  }
  return { nature, chargeType, competencePeriod };
}

// Primeiro dia do mês do `issueDate` (YYYY-MM-DD), ou null se formato inválido.
// Ex: "2026-05-15" -> "2026-05-01".
export function deriveCompetenceFromIssueDate(issueDate: string): string | null {
  const m = issueDate.match(/^(\d{4})-(\d{2})-\d{2}$/);
  return m ? `${m[1]}-${m[2]}-01` : null;
}

// Em paridade com `runRecurringGeneration`: payable+supplier -> supplier_service,
// payable sem supplier -> expense. Receivable usa 'quota' como fallback (quotas
// reais vêm via budget/generate_quotas, não por aqui).
export function inferChargeType(args: {
  kind: "receivable" | "payable";
  supplierId: string | null | undefined;
}): string {
  if (args.kind === "payable") {
    return args.supplierId ? "supplier_service" : "expense";
  }
  return "quota";
}
