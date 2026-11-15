// Settlement - interface pública do módulo. Callers TS (charge/auto_offset,
// allocation/execute, bank_transaction/reverse) importam deste ficheiro, nunca
// dos internos (operation/validate/effects/effects_math/charge_status/_projection).

export {
  createSettlement,
  type CreateSettlementInput,
  createSettlementInTx,
  type CreateSettlementResult,
  reverseSettlement,
} from "./operation.ts";

export {
  type AppliedSettlementResult,
  applyReverseEffects,
  applySettlementEffects,
  type SettlementForEffects,
} from "./effects.ts";

export { type SettlementInput, type SettlementType, validateSettlement } from "./validate.ts";

export { computeChargeStatus } from "./charge_status.ts";

export {
  formatSettlementForResponse,
  SETTLEMENT_PROJECTION,
  type SettlementNestedBankTransaction,
  type SettlementNestedCharge,
} from "./_projection.ts";
