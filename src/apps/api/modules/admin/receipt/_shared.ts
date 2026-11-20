// Tipos partilhados do pipeline de emissão. Aqui (não em emit_orchestrator.ts) para evitar
// import circular: pdf/notify consomem `SnapshotsBundle` que o orchestrator produz.

import type {
  BankTxSnapshot,
  CondominiumSnapshot,
  LineSnapshot,
  RecipientSnapshot,
  UnitSnapshot,
} from "$api/libs/postgres/schemas/receipt.ts";

// Recipient "vivo" com campos extra (userId, phone) para o envio de emails (auto-invite).
// NÃO armazenado no JSONB do recibo.
export interface RecipientLive {
  occupantId: string | null;
  userId: string | null;
  name: string;
  nif: string | null;
  email: string | null;
  phone: string | null;
  receiveEmails: boolean;
  chosen?: boolean;
}

// Destinatário escolhido pelo admin: um ocupante da fração ou alguém inserido à mão.
export type ReceiptRecipientChoice =
  | { occupantId: string }
  | { name: string; nif: string; email: string | null };

export interface SnapshotsBundle {
  condominium: CondominiumSnapshot;
  unit: UnitSnapshot;
  recipients: RecipientSnapshot[];
  recipientsLive: RecipientLive[];
  lines: LineSnapshot[];
  bankTx: BankTxSnapshot;
}
