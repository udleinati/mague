// Fonte ÚNICA dos tipos MIME aceites em uploads. Consumida pela validação
// server-side (`validate_attachment.ts`) e pelo atributo HTML `accept` dos
// dropzones - manter o mesmo conjunto nos dois lados evita o cliente deixar
// escolher o que o servidor rejeita com 415.
//
// NOTA: ao acrescentar um tipo, garante os magic bytes correspondentes em
// `validate_attachment.ts` (a allowlist não chega - há verificação de conteúdo).

export const ALLOWED_UPLOAD_MIME_TYPES = [
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/heic",
  "image/heif",
  "application/pdf",
] as const;

/** String pronta para o atributo HTML `accept` de um `<input type="file">`. */
export const UPLOAD_ACCEPT_ATTR = ALLOWED_UPLOAD_MIME_TYPES.join(",");
