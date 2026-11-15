// Instância partilhada do Client - token/origin/cid resolvidos por request
// via ALS (context.ts), por isso uma instância serve todas as requests.
// Instâncias próprias só onde a config difere (auth pré-login, render.ts).

import { Client } from "$shared/client/mod.ts";
import { panelConfig } from "$panel/config.ts";
import { currentCondominiumId, defaultApiHeaders } from "$panel/context.ts";

export const client = new Client({
  baseUrl: panelConfig.apiUrl,
  defaultHeaders: () => defaultApiHeaders(),
  condominiumId: currentCondominiumId,
});
