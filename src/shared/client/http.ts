export type HeadersFactory = Record<string, string> | (() => Record<string, string>);

export type ClientConfig = {
  baseUrl: string;
  defaultHeaders?: HeadersFactory;
  /** Resolver do condomínio ativo (admin-scoped), avaliado por request. O
   *  panel passa `currentCondominiumId` do ALS; ignorado em chamadas sem cid. */
  condominiumId?: string | (() => string);
};

export class HttpClient {
  constructor(
    private readonly baseUrl: string,
    private readonly defaultHeaders: HeadersFactory = {},
  ) {}

  get(url: string, requestInit: RequestInit = {}) {
    return this.request(url, "GET", requestInit);
  }

  post(url: string, requestInit: RequestInit = {}) {
    return this.request(url, "POST", requestInit);
  }

  put(url: string, requestInit: RequestInit = {}) {
    return this.request(url, "PUT", requestInit);
  }

  patch(url: string, requestInit: RequestInit = {}) {
    return this.request(url, "PATCH", requestInit);
  }

  delete(url: string, requestInit: RequestInit = {}) {
    return this.request(url, "DELETE", requestInit);
  }

  private request(url: string, method: string, requestInit: RequestInit = {}) {
    // Um id interpolado com `../` (o Hono descodifica `%2F`) fazia o fetch normalizar
    // o path para outro condomínio, fora do cid que o panel validou.
    if (hasDotSegment(url)) {
      return Promise.reject(
        new ApiError(404, "Recurso não encontrado", {
          error: { code: "NOT_FOUND", message: "Recurso não encontrado" },
        }),
      );
    }
    const base = typeof this.defaultHeaders === "function"
      ? this.defaultHeaders()
      : this.defaultHeaders;
    return fetch(this.baseUrl + url, {
      ...requestInit,
      method,
      headers: mergeHeaders(base, requestInit?.headers),
    });
  }
}

// Segmentos que o WHATWG URL trata como `.`/`..` (incluindo `%2e`).
function hasDotSegment(url: string): boolean {
  const path = url.split(/[?#]/)[0];
  return path.split("/").some((s) => /^(\.|%2e){1,2}$/i.test(s));
}

// Só escolhe o cid do URL nos resources (e2e); a API não o lê e não o recebe.
const CLIENT_ONLY_HEADER = "x-condominium-id";

// Merge de headers case-insensitive: senão `authorization` (base, lowercase) e
// `Authorization` (override) viajavam ambos e fetch concatenava-os com vírgula,
// quebrando o regex `^Bearer\s+(.+)$`. Overrides vencem o base.
function mergeHeaders(
  base: Record<string, string>,
  overrides: HeadersInit | undefined,
): Record<string, string> {
  const result: Record<string, string> = {};
  const seen = new Set<string>([CLIENT_ONLY_HEADER]);
  if (overrides) {
    const entries = overrides instanceof Headers
      ? Array.from(overrides.entries())
      : Array.isArray(overrides)
      ? overrides
      : Object.entries(overrides);
    for (const [k, v] of entries) {
      if (k.toLowerCase() === CLIENT_ONLY_HEADER) continue;
      result[k] = v;
      seen.add(k.toLowerCase());
    }
  }
  for (const [k, v] of Object.entries(base)) {
    if (!seen.has(k.toLowerCase())) result[k] = v;
  }
  return result;
}

export class ApiError extends Error {
  constructor(
    public readonly statusCode: number,
    message: string,
    public readonly data?: unknown,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

export type AsyncResult<T> = Promise<{ data: T; status: number }>;

export async function validateResponse<T>(response: Response): AsyncResult<T> {
  if (response.status === 204) {
    return { data: undefined as unknown as T, status: response.status };
  }

  let body: unknown;
  const contentType = response.headers.get("content-type") ?? "";
  if (contentType.includes("application/json")) {
    body = await response.json();
  } else {
    body = await response.text();
  }

  if (!response.ok) {
    // Formato de erro da API: { error: { code, message, detail? } }
    let message = response.statusText;
    if (typeof body === "string") {
      message = body.substring(0, 200);
    } else if (typeof body === "object" && body !== null) {
      const b = body as Record<string, unknown>;
      if (typeof b["error"] === "object" && b["error"] !== null) {
        const e = b["error"] as Record<string, unknown>;
        if (typeof e["message"] === "string") message = e["message"];
      } else if (typeof b["message"] === "string") {
        message = b["message"];
      }
    }
    throw new ApiError(response.status, message, body);
  }

  // A API envolve respostas de sucesso em { data: T } - desempacotar
  const data = (typeof body === "object" && body !== null && "data" in body)
    ? (body as { data: T }).data
    : body as T;

  return { data, status: response.status };
}
