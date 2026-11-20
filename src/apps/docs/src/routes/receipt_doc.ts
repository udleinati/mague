// OpenAPI dos endpoints de recibos (`finance.receipt`). Gerados de
// bank_transactions reconciliadas com uma fração (vw_pending_receipts).
// Imutáveis após emissão; só anuláveis via `void`.

import { createRoute, RouteConfig, z } from "@hono/zod-openapi";
import { ErrorResponseDoc } from "$apps/docs/src/types/_common.ts";

const CondoOnlyParamsDoc = z.object({
  cid: z.string().openapi({ example: "MgX001" }),
});

const ReceiptParamsDoc = z.object({
  cid: z.string().openapi({ example: "MgX001" }),
  receiptId: z.string().openapi({ example: "Re5cIp7AbC", description: "nanoid(10)" }),
});

const ReceiptDoc = z.object({
  id: z.string(),
  condominiumId: z.string(),
  number: z.string().openapi({
    example: "2026/00042",
    description: "Número formatado YYYY/NNNNN, sequência por condomínio.",
  }),
  year: z.number().int(),
  unitId: z.string(),
  bankTransactionId: z.string(),
  amountCents: z.number().int(),
  paymentDate: z.string().openapi({ example: "2026-03-15" }),
  issuedAt: z.string(),
  issuedBy: z.record(z.string(), z.unknown()),
  voidedAt: z.string().nullable(),
  voidedBy: z.record(z.string(), z.unknown()).nullable(),
  voidReason: z.string().nullable(),
  storageKey: z.string().nullable().openapi({ description: "S3 key do PDF gerado." }),
  storageEtag: z.string().nullable(),
  emailSentTo: z.array(z.record(z.string(), z.unknown())).nullable(),
  createdAt: z.string(),
});

const PendingReceiptDoc = z.object({
  bankTransactionId: z.string(),
  unitId: z.string(),
  unitDesignation: z.string(),
  paymentDate: z.string(),
  bankTxAmount: z.number().int(),
  recipientAmount: z.number().int(),
  bankAccountId: z.string(),
});

const EmitReceiptBodyDoc = z.object({
  bankTransactionId: z.string(),
  unitId: z.string(),
  recipient: z.union([
    z.object({ occupantId: z.string() }),
    z.object({ name: z.string(), nif: z.string(), email: z.string().nullable().optional() }),
  ]).optional().openapi({
    description: "Destinatário único escolhido pelo admin: ocupante da fração à data do " +
      "pagamento (ver `recipient-options`) ou destinatário manual (nome + NIF, email opcional). " +
      "Omitido = owners + residents. O escolhido recebe o email mesmo com opt-out.",
  }),
});

const RecipientOptionsDoc = z.object({
  paymentDate: z.string().openapi({ example: "2026-09-24" }),
  amountCents: z.number().int(),
  candidates: z.array(z.object({
    occupantId: z.string(),
    name: z.string(),
    nif: z.string().nullable(),
    email: z.string().nullable(),
    relationshipType: z.enum(["owner", "tenant", "resident"]),
  })),
});

const EmitReceiptResponseDoc = z.object({
  receiptId: z.string(),
  number: z.string(),
  amountCents: z.number().int(),
  emailsSent: z.number().int(),
  emailsFailed: z.number().int(),
});

const EmitBulkBodyDoc = z.object({
  pairs: z.array(z.object({
    bankTransactionId: z.string(),
    unitId: z.string(),
  })),
});

const VoidReceiptBodyDoc = z.object({
  reason: z.string().min(1).openapi({
    description: "Motivo da anulação (mínimo 1 caractere).",
  }),
});

const PaginationDoc = z.object({
  page: z.number().int(),
  perPage: z.number().int(),
  total: z.number().int(),
  totalPages: z.number().int(),
});

export const listReceiptsDoc: RouteConfig = {
  description:
    "Lista recibos do condomínio. Filtros: year (integer), unitId, voided (true|false). " +
    "Paginação opcional via `page` + `perPage` (default perPage=500, cap 1000). " +
    "Sem `page`, devolve até `limit` rows (default 1000, cap 2000). " +
    "Inclui `meta.availableYears` se `withMeta=1`.",
  method: "get",
  path: "/admin/condominiums/{cid}/receipts",
  request: {
    params: CondoOnlyParamsDoc,
    query: z.object({
      year: z.string().optional().openapi({ example: "2026" }),
      unitId: z.string().optional(),
      voided: z.enum(["true", "false"]).optional(),
      withMeta: z.enum(["1", "true"]).optional(),
      limit: z.string().optional().openapi({ example: "1000" }),
      page: z.string().optional(),
      perPage: z.string().optional(),
    }),
  },
  responses: {
    200: {
      content: {
        "application/json": {
          schema: z.object({
            data: z.array(ReceiptDoc),
            meta: z.object({ availableYears: z.array(z.number().int()) }).optional(),
            pagination: PaginationDoc.optional(),
          }),
        },
      },
      description: "Lista",
    },
  },
};

export const listPendingReceiptsDoc: RouteConfig = {
  description:
    "Lista pares (bank_transaction, unit) elegíveis para emissão de recibo " +
    "- vem da view `finance.vw_pending_receipts`.",
  method: "get",
  path: "/admin/condominiums/{cid}/receipts/pending",
  request: { params: CondoOnlyParamsDoc },
  responses: {
    200: {
      content: { "application/json": { schema: z.object({ data: z.array(PendingReceiptDoc) }) } },
      description: "Pendentes",
    },
  },
};

export const listRecipientOptionsDoc: RouteConfig = {
  description: "Ocupantes ligados à fração na data do pagamento (qualquer relação), para " +
    "escolher o destinatário do recibo antes de emitir. O par tem de estar pendente.",
  method: "get",
  path: "/admin/condominiums/{cid}/receipts/recipient-options",
  request: {
    params: CondoOnlyParamsDoc,
    query: z.object({ bankTransactionId: z.string(), unitId: z.string() }),
  },
  responses: {
    200: {
      content: { "application/json": { schema: z.object({ data: RecipientOptionsDoc }) } },
      description: "Candidatos",
    },
    422: {
      content: { "application/json": { schema: ErrorResponseDoc } },
      description: "Par não pendente (já emitido, ignorado ou inexistente)",
    },
  },
};

export const getReceiptDoc: RouteConfig = {
  description: "Obtém recibo pelo ID.",
  method: "get",
  path: "/admin/condominiums/{cid}/receipts/{receiptId}",
  request: { params: ReceiptParamsDoc },
  responses: {
    200: {
      content: { "application/json": { schema: z.object({ data: ReceiptDoc }) } },
      description: "Encontrado",
    },
    404: {
      content: { "application/json": { schema: ErrorResponseDoc } },
      description: "Não encontrado",
    },
  },
};

export const emitReceiptDoc: RouteConfig = {
  description:
    "Emite um recibo para o par (bankTransactionId, unitId). Pipeline: " +
    "valida elegibilidade → reserva número → INSERT → render PDF → " +
    "upload S3 → envia email(s). Idempotente: chamar 2× para o mesmo par " +
    "não duplica. Header opcional `X-Panel-Base-URL` para construir links " +
    "nos emails.",
  method: "post",
  path: "/admin/condominiums/{cid}/receipts",
  request: {
    params: CondoOnlyParamsDoc,
    body: { content: { "application/json": { schema: EmitReceiptBodyDoc } } },
  },
  responses: {
    201: {
      content: { "application/json": { schema: z.object({ data: EmitReceiptResponseDoc }) } },
      description: "Recibo emitido",
    },
    400: {
      content: { "application/json": { schema: ErrorResponseDoc } },
      description: "Inelegível, validação ou pipeline falhou",
    },
  },
};

export const emitBulkReceiptsDoc: RouteConfig = {
  description:
    "Emite múltiplos recibos em sequência (uso: 'emitir todos os pendentes'). " +
    "Cada par é processado independentemente; resposta agrega resultados " +
    "com totais de sucesso e falhas.",
  method: "post",
  path: "/admin/condominiums/{cid}/receipts/bulk",
  request: {
    params: CondoOnlyParamsDoc,
    body: { content: { "application/json": { schema: EmitBulkBodyDoc } } },
  },
  responses: {
    200: {
      content: {
        "application/json": {
          schema: z.object({
            data: z.object({
              succeeded: z.number().int(),
              failed: z.number().int(),
              results: z.array(z.union([EmitReceiptResponseDoc, ErrorResponseDoc])),
            }),
          }),
        },
      },
      description: "Resultados consolidados",
    },
  },
};

export const voidReceiptDoc: RouteConfig = {
  description:
    "Anula um recibo já emitido (motivo obrigatório). Recibo permanece em BD " +
    "mas marcado como anulado; PDF original permanece em S3 para auditoria. " +
    "Não cria novo recibo automaticamente.",
  method: "post",
  path: "/admin/condominiums/{cid}/receipts/{receiptId}/void",
  request: {
    params: ReceiptParamsDoc,
    body: { content: { "application/json": { schema: VoidReceiptBodyDoc } } },
  },
  responses: {
    200: {
      content: { "application/json": { schema: z.object({ data: ReceiptDoc }) } },
      description: "Anulado",
    },
    400: {
      content: { "application/json": { schema: ErrorResponseDoc } },
      description: "Validação ou já anulado",
    },
    404: {
      content: { "application/json": { schema: ErrorResponseDoc } },
      description: "Não encontrado",
    },
  },
};

export const resendReceiptEmailDoc: RouteConfig = {
  description:
    "Reenvia o PDF do recibo por email aos owners com receive_receipt_emails=TRUE.",
  method: "post",
  path: "/admin/condominiums/{cid}/receipts/{receiptId}/resend-email",
  request: { params: ReceiptParamsDoc },
  responses: {
    200: {
      content: {
        "application/json": {
          schema: z.object({
            data: z.object({ emailsSent: z.number().int(), emailsFailed: z.number().int() }),
          }),
        },
      },
      description: "Email reenviado",
    },
    404: {
      content: { "application/json": { schema: ErrorResponseDoc } },
      description: "Recibo não encontrado",
    },
  },
};

export const serveReceiptPdfDoc: RouteConfig = {
  description: "Serve os bytes do PDF do recibo (admin).",
  method: "get",
  path: "/admin/condominiums/{cid}/receipts/{receiptId}/pdf",
  request: { params: ReceiptParamsDoc },
  responses: {
    200: { content: { "application/pdf": {} }, description: "PDF" },
    404: {
      content: { "application/json": { schema: ErrorResponseDoc } },
      description: "PDF não encontrado",
    },
  },
};

export const trackReceiptAccessDoc: RouteConfig = {
  description:
    "Marca primeiro download/acesso do PDF por occupant (chamado pelo portal " +
    "antes de servir bytes). Idempotente para o par (receipt, occupant). " +
    "Anti-IDOR: occupant tem que ser recipient do recibo.",
  method: "post",
  path: "/admin/condominiums/{cid}/receipts/{receiptId}/access",
  request: {
    params: ReceiptParamsDoc,
    body: {
      content: {
        "application/json": {
          schema: z.object({ occupantId: z.string() }),
        },
      },
    },
  },
  responses: {
    200: { description: "Tracked (ou já tinha sido)" },
    403: {
      content: { "application/json": { schema: ErrorResponseDoc } },
      description: "Occupant sem acesso ao recibo",
    },
    404: {
      content: { "application/json": { schema: ErrorResponseDoc } },
      description: "Recibo não encontrado",
    },
  },
};

const routes = [
  listReceiptsDoc,
  listPendingReceiptsDoc,
  listRecipientOptionsDoc,
  getReceiptDoc,
  emitReceiptDoc,
  emitBulkReceiptsDoc,
  voidReceiptDoc,
  resendReceiptEmailDoc,
  serveReceiptPdfDoc,
  trackReceiptAccessDoc,
].map((route) => createRoute({ ...route, tags: ["Recibos"], security: [{ bearerAuth: [] }] }));

export default routes;
