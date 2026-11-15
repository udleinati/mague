import { createRoute, RouteConfig, z } from "@hono/zod-openapi";
import { ErrorResponseDoc } from "$apps/docs/src/types/_common.ts";

const CondoOnlyParamsDoc = z.object({
  cid: z.string().openapi({ example: "MgX001" }),
});

const BankAccountParamsDoc = z.object({
  cid: z.string().openapi({ example: "MgX001" }),
  bankAccountId: z.string().openapi({ example: "Ba2nkKc0uN", description: "nanoid(10)" }),
});

const BankAccountDoc = z.object({
  id: z.string(),
  condominiumId: z.string(),
  bankName: z.string().openapi({ example: "NovoBanco" }),
  accountName: z.string().nullable(),
  iban: z.string().nullable(),
  isActive: z.boolean(),
  openingBalance: z.number().openapi({ description: "Total inicial em cêntimos" }),
  openingBalanceOrdinaryCents: z.number(),
  openingBalanceFcrCents: z.number(),
  openingBalanceDate: z.string().nullable(),
  csvConfig: z.record(z.string(), z.unknown()).nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

const CreateBankAccountBodyDoc = z.object({
  bankName: z.string().min(1).max(100),
  accountName: z.string().max(255).nullable().optional(),
  iban: z.string().max(34).nullable().optional(),
  isActive: z.boolean().optional(),
  csvConfig: z.record(z.string(), z.unknown()).nullable().optional(),
});

const UpdateBankAccountBodyDoc = CreateBankAccountBodyDoc.partial();

const OpeningBalanceBodyDoc = z.object({
  openingBalanceOrdinary: z.string().openapi({
    example: "1234,56",
    description: "Euros (aceita vírgula ou ponto)",
  }),
  openingBalanceFcr: z.string().openapi({ example: "500,00" }),
  openingBalanceDate: z.string().openapi({ example: "2026-01-01" }),
});

const ImportPreviewResponseDoc = z.object({
  data: z.object({
    filename: z.string(),
    summary: z.object({
      total: z.number(),
      new: z.number(),
      duplicates: z.number(),
    }),
    warnings: z.array(z.string()),
    rows: z.array(z.any()),
  }),
});

const ImportCommitBodyDoc = z.object({
  rows: z.array(z.any()),
  filename: z.string().optional(),
});

export const listBankAccountsDoc: RouteConfig = {
  description: "Lista contas bancárias do condomínio.",
  method: "get",
  path: "/admin/condominiums/{cid}/bank-accounts",
  request: { params: CondoOnlyParamsDoc },
  responses: {
    200: {
      content: { "application/json": { schema: z.object({ data: z.array(BankAccountDoc) }) } },
      description: "Lista",
    },
  },
};

const BankAccountWithStatsDoc = BankAccountDoc.extend({
  txCount: z.number().int().openapi({
    description: "Total de bank_transactions associadas (não-eliminadas)",
  }),
  pendingCount: z.number().int().openapi({
    description: "Bank_transactions com status='unreconciled'",
  }),
  currentBalanceCents: z.number().int().openapi({
    description: "Saldo atual = opening_balance + Σ amount das tx (em cêntimos)",
  }),
});

export const listBankAccountsWithStatsDoc: RouteConfig = {
  description:
    "Variante de `/bank-accounts` com estatísticas pré-agregadas (txCount, " +
    "pendingCount, currentBalanceCents) - uma JOIN+GROUP BY no Postgres em " +
    "vez de o panel puxar todas as bank_transactions e agregar em JS. " +
    "Usado pela página `/admin/c/:cid/bank-accounts`.",
  method: "get",
  path: "/admin/condominiums/{cid}/bank-accounts/with-stats",
  request: { params: CondoOnlyParamsDoc },
  responses: {
    200: {
      content: {
        "application/json": { schema: z.object({ data: z.array(BankAccountWithStatsDoc) }) },
      },
      description: "Lista com stats",
    },
  },
};

export const createBankAccountDoc: RouteConfig = {
  description: "Cria uma nova conta bancária.",
  method: "post",
  path: "/admin/condominiums/{cid}/bank-accounts",
  request: {
    params: CondoOnlyParamsDoc,
    body: { content: { "application/json": { schema: CreateBankAccountBodyDoc } } },
  },
  responses: {
    201: {
      content: { "application/json": { schema: z.object({ data: BankAccountDoc }) } },
      description: "Criada",
    },
    400: {
      content: { "application/json": { schema: ErrorResponseDoc } },
      description: "Validação",
    },
  },
};

export const getBankAccountDoc: RouteConfig = {
  description: "Obtém uma conta bancária pelo ID.",
  method: "get",
  path: "/admin/condominiums/{cid}/bank-accounts/{bankAccountId}",
  request: { params: BankAccountParamsDoc },
  responses: {
    200: {
      content: { "application/json": { schema: z.object({ data: BankAccountDoc }) } },
      description: "Encontrada",
    },
    404: {
      content: { "application/json": { schema: ErrorResponseDoc } },
      description: "Não encontrada",
    },
  },
};

export const updateBankAccountDoc: RouteConfig = {
  description: "Atualiza conta bancária (nome, IBAN, isActive, csvConfig).",
  method: "patch",
  path: "/admin/condominiums/{cid}/bank-accounts/{bankAccountId}",
  request: {
    params: BankAccountParamsDoc,
    body: { content: { "application/json": { schema: UpdateBankAccountBodyDoc } } },
  },
  responses: {
    200: {
      content: { "application/json": { schema: z.object({ data: BankAccountDoc }) } },
      description: "Atualizada",
    },
    404: {
      content: { "application/json": { schema: ErrorResponseDoc } },
      description: "Não encontrada",
    },
  },
};

export const deleteBankAccountDoc: RouteConfig = {
  description:
    "Remove conta bancária (soft delete). Movimentos permanecem em BD mas a conta deixa de aparecer em listagens.",
  method: "delete",
  path: "/admin/condominiums/{cid}/bank-accounts/{bankAccountId}",
  request: { params: BankAccountParamsDoc },
  responses: {
    204: { description: "Removida" },
    404: {
      content: { "application/json": { schema: ErrorResponseDoc } },
      description: "Não encontrada",
    },
  },
};

export const setOpeningBalanceDoc: RouteConfig = {
  description:
    "Define o saldo inicial da conta (split ordinário + FCR). Cria lançamentos no ledger. Irreversível pelo painel.",
  method: "post",
  path: "/admin/condominiums/{cid}/bank-accounts/{bankAccountId}/opening-balance",
  request: {
    params: BankAccountParamsDoc,
    body: { content: { "application/json": { schema: OpeningBalanceBodyDoc } } },
  },
  responses: {
    200: {
      content: { "application/json": { schema: z.object({ data: BankAccountDoc }) } },
      description: "Saldo inicial definido",
    },
    400: {
      content: { "application/json": { schema: ErrorResponseDoc } },
      description: "Valores inválidos ou saldo já definido",
    },
    404: {
      content: { "application/json": { schema: ErrorResponseDoc } },
      description: "Conta não encontrada",
    },
  },
};

export const importBankPreviewDoc: RouteConfig = {
  description:
    "Pré-visualiza um extrato XLSX (formato NovoBanco). Identifica novos vs duplicados. Não grava nada.",
  method: "post",
  path: "/admin/condominiums/{cid}/bank-accounts/{bankAccountId}/import/preview",
  request: {
    params: BankAccountParamsDoc,
    body: {
      content: {
        "multipart/form-data": {
          schema: z.object({
            file: z.instanceof(File).openapi({ type: "string", format: "binary" }),
          }),
        },
      },
    },
  },
  responses: {
    200: {
      content: { "application/json": { schema: ImportPreviewResponseDoc } },
      description: "Pré-visualização",
    },
    400: {
      content: { "application/json": { schema: ErrorResponseDoc } },
      description: "Ficheiro inválido",
    },
  },
};

export const importBankCommitDoc: RouteConfig = {
  description:
    "Commit do extrato após pré-visualização. Grava as linhas selecionadas em bank_transactions.",
  method: "post",
  path: "/admin/condominiums/{cid}/bank-accounts/{bankAccountId}/import/commit",
  request: {
    params: BankAccountParamsDoc,
    body: { content: { "application/json": { schema: ImportCommitBodyDoc } } },
  },
  responses: {
    200: {
      content: {
        "application/json": {
          schema: z.object({ data: z.object({ inserted: z.number(), skipped: z.number() }) }),
        },
      },
      description: "Importação concluída",
    },
    400: {
      content: { "application/json": { schema: ErrorResponseDoc } },
      description: "Payload inválido",
    },
  },
};

const routes = [
  listBankAccountsDoc,
  listBankAccountsWithStatsDoc,
  createBankAccountDoc,
  getBankAccountDoc,
  updateBankAccountDoc,
  deleteBankAccountDoc,
  setOpeningBalanceDoc,
  importBankPreviewDoc,
  importBankCommitDoc,
].map((route) =>
  createRoute({ ...route, tags: ["Contas Bancárias"], security: [{ bearerAuth: [] }] })
);

export default routes;
