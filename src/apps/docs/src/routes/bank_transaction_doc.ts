import { createRoute, RouteConfig, z } from "@hono/zod-openapi";
import { ErrorResponseDoc } from "$apps/docs/src/types/_common.ts";

const CondoOnlyParamsDoc = z.object({
  cid: z.string().openapi({ example: "MgX001" }),
});

const BankTxParamsDoc = z.object({
  cid: z.string().openapi({ example: "MgX001" }),
  id: z.string().openapi({ example: "Bt8XyZ2qRw", description: "nanoid(10)" }),
});

const BankTransactionDoc = z.object({
  id: z.string(),
  condominiumId: z.string(),
  bankAccountId: z.string(),
  transactionDate: z.string().openapi({ example: "2026-03-15" }),
  valueDate: z.string().nullable(),
  description: z.string().nullable(),
  amountCents: z.number().openapi({ description: "Positivo = entrada, negativo = saída" }),
  balanceAfterCents: z.number().nullable(),
  status: z.enum(["unreconciled", "reconciled"]),
  importBatchId: z.string().nullable(),
  createdAt: z.string(),
});

const CreateBankTransactionBodyDoc = z.object({
  bankAccountId: z.string(),
  transactionDate: z.string(),
  description: z.string().nullable().optional(),
  amountCents: z.number().int(),
  balanceAfterCents: z.number().int().nullable().optional(),
});

const AllocateToUnitBodyDoc = z.object({
  unitId: z.string(),
  chargeId: z.string().nullable().optional().openapi({
    description: "Charge específica a abater. Null = aplica contra saldo mais antigo.",
  }),
});

const AllocateToSupplierBodyDoc = z.object({
  supplierId: z.string(),
  chargeId: z.string().nullable().optional(),
  description: z.string().optional(),
});

const SettlementDoc = z.object({
  id: z.string(),
  condominiumId: z.string(),
  settlementType: z.string().openapi({ example: "bank_reconciliation" }),
  amountCents: z.number(),
  unitId: z.string().nullable(),
  supplierId: z.string().nullable(),
  bankTransactionId: z.string().nullable(),
  debitChargeId: z.string().nullable(),
  creditChargeId: z.string().nullable(),
  settledAt: z.string(),
  notes: z.string().nullable(),
});

const CreateSettlementBodyDoc = z.object({
  settlementType: z.string(),
  amountCents: z.number().int(),
  unitId: z.string().nullable().optional(),
  supplierId: z.string().nullable().optional(),
  bankTransactionId: z.string().nullable().optional(),
  debitChargeId: z.string().nullable().optional(),
  creditChargeId: z.string().nullable().optional(),
  notes: z.string().nullable().optional(),
});

export const listBankTransactionsDoc: RouteConfig = {
  description:
    "Lista movimentos bancários do condomínio (todos, unreconciled, ou filtrados por bankAccountId via query).",
  method: "get",
  path: "/admin/condominiums/{cid}/bank_transactions",
  request: {
    params: CondoOnlyParamsDoc,
    query: z.object({
      bankAccountId: z.string().optional(),
      status: z.enum(["unreconciled", "reconciled"]).optional(),
    }),
  },
  responses: {
    200: {
      content: { "application/json": { schema: z.object({ data: z.array(BankTransactionDoc) }) } },
      description: "Lista",
    },
  },
};

export const createBankTransactionDoc: RouteConfig = {
  description:
    "Cria manualmente um movimento bancário (uso reservado - o panel só permite via import CSV/XLSX).",
  method: "post",
  path: "/admin/condominiums/{cid}/bank_transactions",
  request: {
    params: CondoOnlyParamsDoc,
    body: { content: { "application/json": { schema: CreateBankTransactionBodyDoc } } },
  },
  responses: {
    201: {
      content: { "application/json": { schema: z.object({ data: BankTransactionDoc }) } },
      description: "Criado",
    },
    400: {
      content: { "application/json": { schema: ErrorResponseDoc } },
      description: "Validação",
    },
  },
};

export const allocateToUnitDoc: RouteConfig = {
  description: "Aloca um movimento bancário a uma fração (abate dívida em aberto ou cria crédito).",
  method: "post",
  path: "/admin/condominiums/{cid}/bank_transactions/{id}/allocate_to_unit",
  request: {
    params: BankTxParamsDoc,
    body: { content: { "application/json": { schema: AllocateToUnitBodyDoc } } },
  },
  responses: {
    200: {
      content: { "application/json": { schema: z.object({ data: SettlementDoc }) } },
      description: "Alocado",
    },
    400: {
      content: { "application/json": { schema: ErrorResponseDoc } },
      description: "Inválido (e.g. já conciliado)",
    },
    404: {
      content: { "application/json": { schema: ErrorResponseDoc } },
      description: "Movimento ou fração não encontrados",
    },
  },
};

export const allocateToSupplierDoc: RouteConfig = {
  description: "Aloca um movimento bancário a um fornecedor (pagamento de fatura).",
  method: "post",
  path: "/admin/condominiums/{cid}/bank_transactions/{id}/allocate_to_supplier",
  request: {
    params: BankTxParamsDoc,
    body: { content: { "application/json": { schema: AllocateToSupplierBodyDoc } } },
  },
  responses: {
    200: {
      content: { "application/json": { schema: z.object({ data: SettlementDoc }) } },
      description: "Alocado",
    },
    400: { content: { "application/json": { schema: ErrorResponseDoc } }, description: "Inválido" },
    404: {
      content: { "application/json": { schema: ErrorResponseDoc } },
      description: "Movimento ou fornecedor não encontrados",
    },
  },
};

export const listSettlementsDoc: RouteConfig = {
  description: "Lista settlements (conciliações, alocações, reversões) do condomínio.",
  method: "get",
  path: "/admin/condominiums/{cid}/settlements",
  request: { params: CondoOnlyParamsDoc },
  responses: {
    200: {
      content: { "application/json": { schema: z.object({ data: z.array(SettlementDoc) }) } },
      description: "Lista",
    },
  },
};

export const createSettlementDoc: RouteConfig = {
  description:
    "Cria manualmente um settlement (conciliação charge↔tx, compensação debit↔credit, etc.).",
  method: "post",
  path: "/admin/condominiums/{cid}/settlements",
  request: {
    params: CondoOnlyParamsDoc,
    body: { content: { "application/json": { schema: CreateSettlementBodyDoc } } },
  },
  responses: {
    201: {
      content: { "application/json": { schema: z.object({ data: SettlementDoc }) } },
      description: "Criado",
    },
    400: {
      content: { "application/json": { schema: ErrorResponseDoc } },
      description: "Validação",
    },
  },
};

const IgnoreReasonBodyDoc = z.object({
  reason: z.string().min(1).openapi({
    description:
      "Motivo (ex.: 'movimento manual sem charge associada'). Gravado em " +
      "`ignore_reason`. Permite voltar a conciliar via `unignore`.",
  }),
});

const ReverseBodyDoc = z.object({
  reason: z.string().min(1).openapi({
    description:
      "Motivo da reversão. Cria settlements compensatórios - não apaga histórico.",
  }),
});

export const ignoreBankTransactionDoc: RouteConfig = {
  description:
    "Marca uma bank_transaction como 'ignorada' (status='ignored'). Não " +
    "aparece nas listagens de pendentes mas permanece em BD. Idempotente: " +
    "chamar 2× não muda o estado.",
  method: "post",
  path: "/admin/condominiums/{cid}/bank_transactions/{id}/ignore",
  request: {
    params: BankTxParamsDoc,
    body: { content: { "application/json": { schema: IgnoreReasonBodyDoc } } },
  },
  responses: {
    200: {
      content: { "application/json": { schema: z.object({ data: BankTransactionDoc }) } },
      description: "Ignorada",
    },
    404: {
      content: { "application/json": { schema: ErrorResponseDoc } },
      description: "Movimento não encontrado",
    },
  },
};

export const unignoreBankTransactionDoc: RouteConfig = {
  description:
    "Remove a marca de 'ignorada' (volta a status='unreconciled'). Útil " +
    "se o admin marcou por engano.",
  method: "post",
  path: "/admin/condominiums/{cid}/bank_transactions/{id}/unignore",
  request: { params: BankTxParamsDoc },
  responses: {
    200: {
      content: { "application/json": { schema: z.object({ data: BankTransactionDoc }) } },
      description: "Designorada",
    },
    404: {
      content: { "application/json": { schema: ErrorResponseDoc } },
      description: "Movimento não encontrado",
    },
  },
};

export const reverseBankTransactionDoc: RouteConfig = {
  description:
    "Reverte uma bank_transaction já conciliada - cria settlements " +
    "inversos para anular o efeito sobre as charges, sem apagar histórico. " +
    "Operação irreversível pelo painel; requer motivo.",
  method: "post",
  path: "/admin/condominiums/{cid}/bank_transactions/{id}/reverse",
  request: {
    params: BankTxParamsDoc,
    body: { content: { "application/json": { schema: ReverseBodyDoc } } },
  },
  responses: {
    200: {
      content: {
        "application/json": {
          schema: z.object({
            data: z.object({
              bankTransaction: BankTransactionDoc,
              settlementsReversed: z.number().int(),
            }),
          }),
        },
      },
      description: "Revertida",
    },
    400: {
      content: { "application/json": { schema: ErrorResponseDoc } },
      description: "Não conciliada ou já revertida",
    },
    404: {
      content: { "application/json": { schema: ErrorResponseDoc } },
      description: "Movimento não encontrado",
    },
  },
};

const routes = [
  listBankTransactionsDoc,
  createBankTransactionDoc,
  allocateToUnitDoc,
  allocateToSupplierDoc,
  ignoreBankTransactionDoc,
  unignoreBankTransactionDoc,
  reverseBankTransactionDoc,
  listSettlementsDoc,
  createSettlementDoc,
].map((route) =>
  createRoute({ ...route, tags: ["Movimentos Bancários"], security: [{ bearerAuth: [] }] })
);

export default routes;
