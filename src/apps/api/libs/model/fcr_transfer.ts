// Espelha enums e regras do schema Drizzle de fcr_transfer, mais o mapa
// direção -> bolsas do ledger. Ver docs/flows/05-fluxo-fcr.md.

import { z } from "zod";
import {
  FCR_TRANSFER_DIRECTIONS,
  type FcrTransferDirection,
} from "$api/libs/postgres/schemas/fcr_transfer.ts";

// Bolsas de asset - ver seeds/000a_chart_of_account_global.sql.
export const ACC_BANK_ORDINARY = "121"; // Depósitos à ordem - Conta Ordinária
export const ACC_BANK_FCR = "122"; // Depósitos à ordem - Conta FCR

export const fcrTransferCreateSchema = z.object({
  direction: z.enum(FCR_TRANSFER_DIRECTIONS),
  amountCents: z.number().int().positive(),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "data deve ser YYYY-MM-DD"),
  reason: z.string().trim().min(1, "motivo obrigatório").max(2000),
});

export type FcrTransferCreate = z.infer<typeof fcrTransferCreateSchema>;

/** Bolsa debitada e creditada. `to_fcr` tira do ordinário e põe no FCR. */
export function fcrTransferAccounts(
  direction: FcrTransferDirection,
): { debit: string; credit: string } {
  return direction === "to_fcr"
    ? { debit: ACC_BANK_FCR, credit: ACC_BANK_ORDINARY }
    : { debit: ACC_BANK_ORDINARY, credit: ACC_BANK_FCR };
}

/** Saldo da bolsa de origem - a que tem de cobrir o montante. */
export function fcrTransferSourceBalance(
  direction: FcrTransferDirection,
  balances: { ordinaryCents: number; fcrCents: number },
): number {
  return direction === "to_fcr" ? balances.ordinaryCents : balances.fcrCents;
}

export function fcrTransferSourceLabel(direction: FcrTransferDirection): string {
  return direction === "to_fcr" ? "bolsa ordinária" : "bolsa FCR";
}
