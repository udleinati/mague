import { z } from "@hono/zod-openapi";

// Envelope de erro partilhado (todos os handlers usam AppError).
export const ErrorResponseDoc = z.object({
  error: z.object({
    code: z.string().openapi({ example: "VALIDATION_ERROR" }),
    message: z.string().openapi({ example: "error during validation" }),
    detail: z.record(z.string(), z.unknown()).optional(),
  }),
});

// Parâmetro comum a todas as rotas admin (escopo por condomínio).
export const CondominiumScopeParamsDoc = z.object({
  cid: z.string().openapi({ example: "MgX001", description: "ID do condomínio (nanoid 6)" }),
});
