import { type AsyncResult } from "../http.ts";
import { ManagerResource } from "../admin.ts";

declare module "../admin.ts" {
  interface ManagerResource {
    listBankAccounts(requestInit?: RequestInit): AsyncResult<Record<string, unknown>[]>;
    listBankAccountsWithStats(requestInit?: RequestInit): AsyncResult<
      Array<
        Record<string, unknown> & {
          txCount: number;
          pendingCount: number;
          currentBalanceCents: number;
        }
      >
    >;
    getBankAccountsBalances(requestInit?: RequestInit): AsyncResult<{
      ordinaryCents: number;
      fcrCents: number;
      totalCents: number;
    }>;
    getBankAccount(
      bankAccountId: string,
      requestInit?: RequestInit,
    ): AsyncResult<Record<string, unknown>>;
    createBankAccount(
      body: Record<string, unknown>,
      requestInit?: RequestInit,
    ): AsyncResult<Record<string, unknown>>;
    updateBankAccount(
      bankAccountId: string,
      body: Record<string, unknown>,
      requestInit?: RequestInit,
    ): AsyncResult<Record<string, unknown>>;
    deleteBankAccount(bankAccountId: string, requestInit?: RequestInit): AsyncResult<void>;
    setBankAccountOpeningBalance(
      bankAccountId: string,
      body: { ordinary_cents: number; fcr_cents: number; date: string },
      requestInit?: RequestInit,
    ): AsyncResult<{
      openingBalance: number;
      openingBalanceOrdinaryCents: number;
      openingBalanceFcrCents: number;
      openingBalanceDate: string;
      chargesCreated: number;
    }>;
    previewBankStatementImport(
      bankAccountId: string,
      file: File | Blob,
      filename: string,
      requestInit?: RequestInit,
    ): AsyncResult<
      { rows: Array<Record<string, unknown>>; summary: Record<string, unknown>; filename: string }
    >;
    commitBankStatementImport(
      bankAccountId: string,
      body: { rows: Array<Record<string, unknown>>; filename?: string },
      requestInit?: RequestInit,
    ): AsyncResult<{ created: number; skipped: number; importBatchId: string | null }>;
  }
}

// Bank accounts
export function registerBankAccountMethods(): void {
  ManagerResource.prototype.listBankAccounts = function (requestInit) {
    return this.request<Record<string, unknown>[]>("GET", "/bank-accounts", requestInit);
  };

  /** bank_accounts com stats agregadas server-side (saldo atual = opening +
   *  Σ tx, txCount, pendingCount), evitando agregar no panel. */
  ManagerResource.prototype.listBankAccountsWithStats = function (requestInit) {
    return this.request<
      Array<
        Record<string, unknown> & {
          txCount: number;
          pendingCount: number;
          currentBalanceCents: number;
        }
      >
    >("GET", "/bank-accounts/with-stats", requestInit);
  };

  /** Saldo atual por bolsa: ordinário (account 121) vs FCR (122).
   *  Computado sobre o ledger - fonte de verdade contabilística. */
  ManagerResource.prototype.getBankAccountsBalances = function (requestInit) {
    return this.request<{
      ordinaryCents: number;
      fcrCents: number;
      totalCents: number;
    }>("GET", "/bank-accounts/balances", requestInit);
  };

  ManagerResource.prototype.getBankAccount = function (bankAccountId, requestInit) {
    return this.request<Record<string, unknown>>(
      "GET",
      `/bank-accounts/${bankAccountId}`,
      requestInit,
    );
  };

  ManagerResource.prototype.createBankAccount = function (body, requestInit) {
    return this.request<Record<string, unknown>>("POST", "/bank-accounts", requestInit, body);
  };

  ManagerResource.prototype.updateBankAccount = function (bankAccountId, body, requestInit) {
    return this.request<Record<string, unknown>>(
      "PATCH",
      `/bank-accounts/${bankAccountId}`,
      requestInit,
      body,
    );
  };

  ManagerResource.prototype.deleteBankAccount = function (bankAccountId, requestInit) {
    return this.request<void>("DELETE", `/bank-accounts/${bankAccountId}`, requestInit);
  };

  ManagerResource.prototype.setBankAccountOpeningBalance = function (
    bankAccountId,
    body,
    requestInit,
  ) {
    return this.request<{
      openingBalance: number;
      openingBalanceOrdinaryCents: number;
      openingBalanceFcrCents: number;
      openingBalanceDate: string;
      chargesCreated: number;
    }>("POST", `/bank-accounts/${bankAccountId}/opening-balance`, requestInit, body);
  };

  ManagerResource.prototype.previewBankStatementImport = function (
    bankAccountId,
    file,
    filename,
    requestInit,
  ) {
    return this.upload<
      { rows: Array<Record<string, unknown>>; summary: Record<string, unknown>; filename: string }
    >(`/bank-accounts/${bankAccountId}/import/preview`, file, filename, undefined, requestInit);
  };

  ManagerResource.prototype.commitBankStatementImport = function (
    bankAccountId,
    body,
    requestInit,
  ) {
    return this.request<{ created: number; skipped: number; importBatchId: string | null }>(
      "POST",
      `/bank-accounts/${bankAccountId}/import/commit`,
      requestInit,
      body,
    );
  };
}
