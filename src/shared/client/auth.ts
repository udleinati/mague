import { type AsyncResult, HttpClient, validateResponse } from "./http.ts";

export interface AuthMe {
  user: {
    id: string;
    email: string | null;
    name: string | null;
    role: string;
    /** Preferência de tema persistida. */
    theme?: "light" | "dark" | null;
    /** Timestamp do aviso de privacidade. NULL = não aceitou;
     *  middleware do panel redirecciona para /privacy-notice enquanto NULL. */
    termsAcknowledgedAt?: string | null;
  };
  managedCondominiumIds: string[];
  /** Frações ligadas ao user (role=occupant); vazio para super/admin.
   *  `nif` é per-occupant/condo. */
  occupantUnits: Array<{
    unitId: string;
    condominiumId: string;
    designation: string;
    identifier?: string | null;
    condominiumName?: string;
    occupantId: string;
    nif: string | null;
  }>;
}

export interface AuthSessionResponse {
  /** JWT (HS256) - usar em `Authorization: Bearer <token>`. */
  token: string;
  expiresAt: string;
  user: {
    id: string;
    email: string | null;
    name: string | null;
    role: string;
    theme?: "light" | "dark" | null;
    termsAcknowledgedAt?: string | null;
  };
}

export class AuthResource {
  private basePath = "/v1";
  constructor(private readonly httpClient: HttpClient) {}

  /** `identifier` aceita email OU NIF. Detecção server-side por presença de `@`. */
  async login(identifier: string, password: string): AsyncResult<AuthSessionResponse> {
    const response = await this.httpClient.post(`${this.basePath}/auth/login`, {
      body: JSON.stringify({ identifier, password }),
      headers: { "Content-Type": "application/json" },
    });
    return validateResponse<AuthSessionResponse>(response);
  }

  /** GET /v1/auth/invite/:token - preview do convite (sem auth). */
  async previewInvite(token: string): AsyncResult<{
    purpose: string;
    user: { name: string; email: string | null };
    expiresAt: string;
  }> {
    const response = await this.httpClient.get(
      `${this.basePath}/auth/invite/${encodeURIComponent(token)}`,
    );
    return validateResponse(response);
  }

  /** POST /v1/auth/accept-invite - define password e devolve sessão. */
  async acceptInvite(token: string, password: string): AsyncResult<AuthSessionResponse> {
    const response = await this.httpClient.post(`${this.basePath}/auth/accept-invite`, {
      body: JSON.stringify({ token, password }),
      headers: { "Content-Type": "application/json" },
    });
    return validateResponse<AuthSessionResponse>(response);
  }

  /** POST /v1/auth/forgot-password - sempre devolve 204 (sem leak). */
  async forgotPassword(identifier: string): Promise<void> {
    await this.httpClient.post(`${this.basePath}/auth/forgot-password`, {
      body: JSON.stringify({ identifier }),
      headers: { "Content-Type": "application/json" },
    });
  }

  /** POST /v1/auth/reset-password - define nova password e devolve sessão. */
  async resetPassword(token: string, password: string): AsyncResult<AuthSessionResponse> {
    const response = await this.httpClient.post(`${this.basePath}/auth/reset-password`, {
      body: JSON.stringify({ token, password }),
      headers: { "Content-Type": "application/json" },
    });
    return validateResponse<AuthSessionResponse>(response);
  }

  /** `token` é o JWT devolvido pelo login. Passado em Authorization Bearer. */
  async me(token: string): AsyncResult<AuthMe> {
    const response = await this.httpClient.get(`${this.basePath}/auth/me`, {
      headers: { "Authorization": `Bearer ${token}` },
    });
    return validateResponse<AuthMe>(response);
  }

  /** Revoga a sessão em Valkey. Envia o JWT em `Authorization: Bearer`. */
  async logout(token: string): AsyncResult<{ loggedOut: boolean }> {
    const response = await this.httpClient.post(`${this.basePath}/auth/logout`, {
      body: JSON.stringify({}),
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${token}`,
      },
    });
    return validateResponse<{ loggedOut: boolean }>(response);
  }

  // O NIF é per-occupant. Stub que lança para apanhar
  // callers não migrados; usar `client.portal.saveOccupantNif`.
  saveNif(_token: string, _nif: string): AsyncResult<{ nif: string }> {
    throw new Error(
      "auth.saveNif removido. Usa client.portal.saveOccupantNif(cid, unitId, nif).",
    );
  }

  /** Persistir preferência de tema. Aceita 'light' | 'dark' | null. */
  async saveTheme(
    token: string,
    theme: "light" | "dark" | null,
  ): AsyncResult<{ theme: string | null }> {
    const response = await this.httpClient.post(`${this.basePath}/auth/me/theme`, {
      body: JSON.stringify({ theme }),
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${token}`,
      },
    });
    return validateResponse<{ theme: string | null }>(response);
  }

  /** Regista o aviso de privacidade do portal. Idempotente: write-once via
   *  COALESCE no servidor (mantém o timestamp original). */
  async saveTermsAcknowledged(token: string): AsyncResult<{ acknowledgedAt: string | null }> {
    const response = await this.httpClient.post(
      `${this.basePath}/auth/me/terms-acknowledged`,
      {
        body: "{}",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${token}`,
        },
      },
    );
    return validateResponse<{ acknowledgedAt: string | null }>(response);
  }

  async changePassword(
    token: string,
    currentPassword: string,
    newPassword: string,
  ): AsyncResult<void> {
    const response = await this.httpClient.post(`${this.basePath}/auth/change-password`, {
      body: JSON.stringify({ currentPassword: currentPassword, newPassword: newPassword }),
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${token}`,
      },
    });
    return validateResponse<void>(response);
  }
}
