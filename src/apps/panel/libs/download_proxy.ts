// Único sítio do panel que constrói headers de download. Converte a Response
// crua da API (client.admin/portal.downloadStream) na resposta servida ao
// browser: passthrough de content-type/disposition com fallbacks por call site.

export interface ProxyDownloadOptions {
  /** Prefixo da mensagem de erro ("Erro ao obter PDF"). Default "Erro". */
  errorPrefix?: string;
  /** Força o content-type (PDFs); default passthrough ?? octet-stream. */
  contentType?: string;
  /** Força o content-disposition; senão passthrough ?? fallbackDisposition. */
  disposition?: string;
  /** Usado quando a API não envia content-disposition. Default "inline". */
  fallbackDisposition?: string;
  /** Força o cache-control; senão passthrough do upstream (se existir). */
  cacheControl?: string;
}

export function proxyDownload(
  upstream: Response,
  opts: ProxyDownloadOptions = {},
): Response {
  if (!upstream.ok) {
    return new Response(`${opts.errorPrefix ?? "Erro"}: HTTP ${upstream.status}`, {
      status: upstream.status,
    });
  }
  const headers = new Headers();
  headers.set(
    "content-type",
    opts.contentType ?? upstream.headers.get("content-type") ?? "application/octet-stream",
  );
  headers.set(
    "content-disposition",
    opts.disposition ?? upstream.headers.get("content-disposition") ??
      opts.fallbackDisposition ?? "inline",
  );
  const length = upstream.headers.get("content-length");
  if (length) headers.set("content-length", length);
  const cacheControl = opts.cacheControl ?? upstream.headers.get("cache-control");
  if (cacheControl) headers.set("cache-control", cacheControl);
  return new Response(upstream.body, { status: 200, headers });
}
