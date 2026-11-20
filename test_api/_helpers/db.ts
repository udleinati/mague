// Helper para executar SQL diretamente contra mague-db nos testes E2E.
// Útil para seedar fixtures que não têm endpoint admin/super (ex: criar
// user com password hash conhecido, inserir invite_token).

const DB_CONTAINER = Deno.env.get("DB_CONTAINER") ?? "mague-db";
/** Nome da BD, derivado do `DATABASE_URL` que a suite já usa. Sem isto o setup
 *  por psql ia sempre para `mague` enquanto a API respondia de outra base, e as
 *  fixtures rebentavam em FK violation. Default `mague` (fluxo normal). */
const DB_NAME = new URL(
  Deno.env.get("DATABASE_URL") ?? "postgres://mague:mague@localhost:5432/mague",
).pathname.slice(1) || "mague";

export async function sqlExec(sql: string): Promise<string> {
  const cmd = new Deno.Command("docker", {
    args: ["exec", "-i", DB_CONTAINER, "psql", "-U", "mague", "-d", DB_NAME, "-tA", "-c", sql],
    stdout: "piped",
    stderr: "piped",
  });
  const { stdout, stderr, code } = await cmd.output();
  if (code !== 0) {
    throw new Error(
      `psql exit ${code} para SQL "${sql.substring(0, 80)}…": ${new TextDecoder().decode(stderr)}`,
    );
  }
  return new TextDecoder().decode(stdout).trim();
}

/** Grava como uma linha anterior ao `trg_tenant_guard` (ligação cruzada antiga): o
 *  guard da tabela fica desligado só dentro desta transação. */
export function sqlExecBeforeTenantGuard(table: string, sql: string): Promise<string> {
  return sqlExec(
    `BEGIN; ALTER TABLE ${table} DISABLE TRIGGER trg_tenant_guard; ${sql};
     ALTER TABLE ${table} ENABLE TRIGGER trg_tenant_guard; COMMIT;`,
  );
}

/**
 * Cria um user de teste ativo com password hash gerado por crypt() do
 * Postgres (extensão pgcrypto, igual ao seed minimal). A password "raw"
 * é a passada em opts.password (default: "test12345").
 *
 * Devolve o id.
 */
export async function seedTestUser(opts: {
  id?: string;
  email: string;
  name?: string;
  /** Aceito por compat - não existe coluna `nif` em
   *  core.user. Ignored silenciosamente. NIF vive em core.occupant. */
  nif?: string;
  /** Pós-ADR 0002: só 'super' ou null. Default é null (= "user comum",
   *  sem privilégio global). Para tornar admin de um condomínio usa
   *  o toggle isManager via PATCH /users/:id ou INSERT em core.manager. */
  role?: "super" | null;
  active?: boolean;
  password?: string;
}): Promise<string> {
  const id = opts.id ?? `usr_${crypto.randomUUID().substring(0, 8)}`;
  const name = opts.name ?? opts.email.split("@")[0];
  const password = opts.password ?? "test12345";
  const roleValue = opts.role === "super" ? "'super'" : "NULL";
  const emailLower = opts.email.toLowerCase();
  await sqlExec(`
    INSERT INTO core."user" (id, email, name, role, is_active, password_hash)
    VALUES ('${id}', '${emailLower}', '${name}', ${roleValue},
            ${opts.active ?? true}, crypt('${password}', gen_salt('bf', 10)))
    ON CONFLICT (id) DO UPDATE SET email=EXCLUDED.email, password_hash=EXCLUDED.password_hash
  `);
  return id;
}

/**
 * Insere um invite_token diretamente em DB. `purpose` é "invite" ou "reset".
 */
export async function seedInviteToken(opts: {
  token: string;
  userId: string;
  purpose: "invite" | "reset";
  ttlSeconds?: number;
  /** Âmbito de quem convidou (`scope_condominium_ids`); omitido = NULL (sem limite). */
  scopeCondominiumIds?: string[];
}): Promise<void> {
  const ttl = opts.ttlSeconds ?? 3600;
  const scope = opts.scopeCondominiumIds
    ? `ARRAY[${opts.scopeCondominiumIds.map((c) => `'${c}'`).join(",")}]::text[]`
    : "NULL";
  await sqlExec(`
    INSERT INTO core.invite_token (token, user_id, purpose, expires_at, scope_condominium_ids)
    VALUES ('${opts.token}', '${opts.userId}', '${opts.purpose}', now() + interval '${ttl} seconds', ${scope})
  `);
}

export async function deleteTestUser(id: string): Promise<void> {
  await sqlExec(`DELETE FROM core.invite_token WHERE user_id = '${id}'`);
  await sqlExec(`DELETE FROM core."user" WHERE id = '${id}'`);
}
