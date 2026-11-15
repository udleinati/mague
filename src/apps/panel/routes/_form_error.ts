// Função pura zero-deps (testável sem flags). Vive separada do `_form_action.ts`
// porque este puxa `condoUrl` -> `.env` (requer --allow-read em testes).

interface ApiErrorShape {
  data?: {
    error?: {
      code?: string;
      message?: string;
      detail?: { errors?: Array<{ message?: unknown }> };
    };
  };
  message?: string;
}

// Erro Zod da API: as mensagens úteis vêm em detail.errors, não no message genérico.
function validationMessages(apiErr: ApiErrorShape): string | null {
  const error = apiErr?.data?.error;
  if (error?.code !== "VALIDATION_ERROR" || !Array.isArray(error.detail?.errors)) return null;
  const messages = error.detail.errors
    .map((e) => e?.message)
    .filter((m): m is string => typeof m === "string" && m.trim() !== "");
  return messages.length > 0 ? messages.join("; ") : null;
}

// Fallback chain: validação -> data.error.message (handler) -> message (status text) -> fallback.
export function extractApiErrorMessage(err: unknown, fallback: string): string {
  const apiErr = err as ApiErrorShape;
  return validationMessages(apiErr) ?? apiErr?.data?.error?.message ?? apiErr?.message ??
    fallback;
}
