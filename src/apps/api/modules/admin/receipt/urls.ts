// Construtores das URLs absolutas dos recibos. Centraliza o formato para evitar drift entre
// os sítios que geram links (notify no emit + resend): um link noutro formato
// (ex.: `/recibos/:id` em vez de `/u/:uid/receipts/:id`) dá 404 no email.

// URL pública do recibo no portal. Inclui `unitId` no path porque o middleware
// `requirePortalAccessToUnit` valida ownership; sem ele, 404.
export function portalReceiptUrl(
  panelBaseUrl: string,
  condominiumId: string,
  unitId: string,
  receiptId: string,
): string {
  return `${panelBaseUrl}/portal/c/${condominiumId}/u/${unitId}/receipts/${receiptId}`;
}
