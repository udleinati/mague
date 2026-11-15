import { type AsyncResult } from "../http.ts";
import { ManagerResource } from "../admin.ts";
import type { User } from "../types.ts";

declare module "../admin.ts" {
  interface ManagerResource {
    listUsers(requestInit?: RequestInit): AsyncResult<User[]>;
    getUser(userId: string, requestInit?: RequestInit): AsyncResult<User>;
    updateUser(
      userId: string,
      body: Record<string, unknown>,
      requestInit?: RequestInit,
    ): AsyncResult<User>;
    deleteUser(userId: string, requestInit?: RequestInit): AsyncResult<void>;
    resetUserPassword(
      userId: string,
      requestInit?: RequestInit,
    ): AsyncResult<TemporaryPasswordReset>;
  }
}

/** Resposta do reset assistido. `temporaryPassword` só existe nesta response. */
export interface TemporaryPasswordReset {
  userId: string;
  name: string;
  email: string | null;
  temporaryPassword: string;
  resetAt: string;
}

// Users
export function registerUserMethods(): void {
  ManagerResource.prototype.listUsers = function (requestInit) {
    return this.request<User[]>("GET", "/users", requestInit);
  };

  ManagerResource.prototype.getUser = function (userId, requestInit) {
    return this.request<User>("GET", `/users/${userId}`, requestInit);
  };

  ManagerResource.prototype.updateUser = function (userId, body, requestInit) {
    return this.request<User>("PATCH", `/users/${userId}`, requestInit, body);
  };

  ManagerResource.prototype.deleteUser = function (userId, requestInit) {
    return this.request<void>("DELETE", `/users/${userId}`, requestInit);
  };

  ManagerResource.prototype.resetUserPassword = function (userId, requestInit) {
    // `{}` e não vazio: sem body o Client não põe Content-Type e o
    // `parseJson()` da API devolve 415. Mesma convenção do inviteOccupant.
    return this.request<TemporaryPasswordReset>(
      "POST",
      `/users/${userId}/reset-password`,
      requestInit,
      {},
    );
  };
}
