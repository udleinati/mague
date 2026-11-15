import { type AsyncResult, HttpClient, validateResponse } from "./http.ts";
import type { Condominium, Unit } from "./types.ts";

export class SuperResource {
  private basePath = "/v1/super";

  constructor(private readonly httpClient: HttpClient) {}

  // Condominiums
  async listCondominiums(requestInit: RequestInit = {}): AsyncResult<Condominium[]> {
    const response = await this.httpClient.get(`${this.basePath}/condominiums`, requestInit);
    return validateResponse<Condominium[]>(response);
  }

  async getCondominium(id: string, requestInit: RequestInit = {}): AsyncResult<Condominium> {
    const response = await this.httpClient.get(`${this.basePath}/condominiums/${id}`, requestInit);
    return validateResponse<Condominium>(response);
  }

  async createCondominium(
    body: Record<string, unknown>,
    requestInit: RequestInit = {},
  ): AsyncResult<Condominium> {
    const response = await this.httpClient.post(`${this.basePath}/condominiums`, {
      ...requestInit,
      body: JSON.stringify(body),
      headers: { ...requestInit.headers, "Content-Type": "application/json" },
    });
    return validateResponse<Condominium>(response);
  }

  async updateCondominium(
    id: string,
    body: Record<string, unknown>,
    requestInit: RequestInit = {},
  ): AsyncResult<Condominium> {
    const response = await this.httpClient.patch(`${this.basePath}/condominiums/${id}`, {
      ...requestInit,
      body: JSON.stringify(body),
      headers: { ...requestInit.headers, "Content-Type": "application/json" },
    });
    return validateResponse<Condominium>(response);
  }

  async deleteCondominium(id: string, requestInit: RequestInit = {}): AsyncResult<void> {
    const response = await this.httpClient.delete(
      `${this.basePath}/condominiums/${id}`,
      requestInit,
    );
    return validateResponse<void>(response);
  }

  // Units
  async listUnits(condominiumId: string, requestInit: RequestInit = {}): AsyncResult<Unit[]> {
    const response = await this.httpClient.get(
      `${this.basePath}/condominiums/${condominiumId}/units`,
      requestInit,
    );
    return validateResponse<Unit[]>(response);
  }

  async getUnit(
    condominiumId: string,
    unitId: string,
    requestInit: RequestInit = {},
  ): AsyncResult<Unit> {
    const response = await this.httpClient.get(
      `${this.basePath}/condominiums/${condominiumId}/units/${unitId}`,
      requestInit,
    );
    return validateResponse<Unit>(response);
  }

  async createUnit(
    condominiumId: string,
    body: Record<string, unknown>,
    requestInit: RequestInit = {},
  ): AsyncResult<Unit> {
    const response = await this.httpClient.post(
      `${this.basePath}/condominiums/${condominiumId}/units`,
      {
        ...requestInit,
        body: JSON.stringify(body),
        headers: { ...requestInit.headers, "Content-Type": "application/json" },
      },
    );
    return validateResponse<Unit>(response);
  }

  async updateUnit(
    condominiumId: string,
    unitId: string,
    body: Record<string, unknown>,
    requestInit: RequestInit = {},
  ): AsyncResult<Unit> {
    const response = await this.httpClient.patch(
      `${this.basePath}/condominiums/${condominiumId}/units/${unitId}`,
      {
        ...requestInit,
        body: JSON.stringify(body),
        headers: { ...requestInit.headers, "Content-Type": "application/json" },
      },
    );
    return validateResponse<Unit>(response);
  }

  async deleteUnit(
    condominiumId: string,
    unitId: string,
    requestInit: RequestInit = {},
  ): AsyncResult<void> {
    const response = await this.httpClient.delete(
      `${this.basePath}/condominiums/${condominiumId}/units/${unitId}`,
      requestInit,
    );
    return validateResponse<void>(response);
  }
}
