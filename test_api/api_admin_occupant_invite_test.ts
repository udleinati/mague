// POST /v1/admin/condominiums/:cid/occupants/:occId/invite
//
// Endpoint único de convite ao occupant (sem precisar de unitId - um
// occupant pode estar em várias frações). Cobre:
//   1. Sucesso: cria user (1.ª chamada), gera token, envia email.
//   2. Cooldown (ADR 0032): re-envio dentro da janela → 422 COOLDOWN_ACTIVE.
//   3. Re-envio depois da janela: cria novo token e invalida o anterior.
//   4. Validação multi-tenant: occupant doutro condo → 404.
//   5. Validação email: occupant sem email → 400 MISSING_EMAIL.
//   6. occupantId inexistente → 404.
//   7. Projeção do user: inviteInCooldown + inviteCooldownUntil refletem a janela.
//   8. Cooldown conta só purpose='invite' (tokens de reset não contam).

import { assertEquals, assertGreater, assertNotEquals } from "@std/assert";
import { describe, it } from "@std/testing/bdd";
import postgresjs from "postgresjs";
import { ApiError, Client, type Condominium } from "$shared/client/mod.ts";
import { loginAsSuper } from "./_helpers/auth.ts";
import { assertRejects } from "@std/assert";

const BASE_URL = "http://localhost:3000";
const DATABASE_URL = Deno.env.get("DATABASE_URL") ??
  "postgres://mague:mague@localhost:5432/mague";
const AUTH = await loginAsSuper();
const client = new Client({ baseUrl: BASE_URL });
const sql = postgresjs(DATABASE_URL, { max: 2 });

// Fetch directo para o endpoint novo (não há método dedicado no SDK ainda
// - o panel chama via fetch + cookies). Mantemos o helper local para o
// test não depender do panel route.
async function inviteByOccupant(cid: string, occId: string, headers: Record<string, string>) {
  const res = await fetch(`${BASE_URL}/v1/admin/condominiums/${cid}/occupants/${occId}/invite`, {
    method: "POST",
    headers: { ...headers, "Content-Type": "application/json" },
    body: "{}",
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new ApiError(res.status, body?.error?.message ?? `Erro ${res.status}`, body);
  }
  return { data: body.data, status: res.status };
}

describe("admin occupant - invite endpoint (sem unitId)", () => {
  let condoA: Condominium;
  let condoB: Condominium;
  let occWithEmailId = "";
  let occNoEmailId = "";
  let occInBId = "";
  let invitedUserId = "";
  const stamp = Date.now();
  const emailA = `invite-occ-a-${stamp}@example.pt`;
  const emailB = `invite-occ-b-${stamp}@example.pt`;
  let headersA: Record<string, string>;

  it("setup - 2 condos + 3 occupants (com email, sem email, em condo B)", async () => {
    const { data: cA } = await client.super.createCondominium(
      { name: "Invite Occ A", fiscalNumber: "509400100" },
      { headers: AUTH },
    );
    condoA = cA;
    headersA = { ...AUTH, "x-condominium-id": condoA.id };

    const { data: cB } = await client.super.createCondominium(
      { name: "Invite Occ B", fiscalNumber: "509400200" },
      { headers: AUTH },
    );
    condoB = cB;

    // Occupant em A com email.
    const { data: o1 } = await client.admin.createOccupant(
      { name: "Maria com Email", type: "owner", email: emailA },
      { headers: headersA },
    );
    occWithEmailId = o1.id;

    // Occupant em A sem email.
    const { data: o2 } = await client.admin.createOccupant(
      { name: "Sem Email", type: "owner" },
      { headers: headersA },
    );
    occNoEmailId = o2.id;

    // Occupant em B (cross-tenant).
    const headersB = { ...AUTH, "x-condominium-id": condoB.id };
    const { data: o3 } = await client.admin.createOccupant(
      { name: "Owner Em B", type: "owner", email: emailB },
      { headers: headersB },
    );
    occInBId = o3.id;
  });

  it("invite ok: cria user, gera token, retorna sentTo", async () => {
    const before = await sql<{ uid: string | null }[]>`
      SELECT user_id AS uid FROM core.occupant WHERE id = ${occWithEmailId}
    `;
    assertEquals(before[0].uid, null);

    const { data, status } = await inviteByOccupant(condoA.id, occWithEmailId, headersA);
    assertEquals(status, 201);
    assertEquals(data.sentTo, emailA);
    assertEquals(typeof data.userId, "string");
    assertEquals(typeof data.expiresAt, "string");
    invitedUserId = String(data.userId);

    // Occupant agora tem user_id linked + 1 token ativo.
    const after = await sql<{ uid: string | null; tokens: number }[]>`
      SELECT
        (SELECT user_id FROM core.occupant WHERE id = ${occWithEmailId}) AS uid,
        (SELECT COUNT(*)::int FROM core.invite_token
          WHERE user_id = (SELECT user_id FROM core.occupant WHERE id = ${occWithEmailId})
            AND purpose = 'invite' AND used_at IS NULL) AS tokens
    `;
    assertNotEquals(after[0].uid, null);
    assertEquals(after[0].tokens, 1);
  });

  it("re-invite dentro da janela -> 422 COOLDOWN_ACTIVE (ADR 0032)", async () => {
    // WHY: o convite acabou de sair (teste anterior). O guard de cooldown
    // (invite_by_occupant.ts) lê o último invite via loadLastInvitedAt e
    // recusa o reenvio dentro de INVITE_RESEND_COOLDOWN_DAYS. É a MESMA fonte
    // que desactiva o botão na UI - 422 e botão nunca divergem.
    const e = await assertRejects(
      () => inviteByOccupant(condoA.id, occWithEmailId, headersA),
      ApiError,
    );
    assertEquals(e.statusCode, 422);
    // O helper local guarda o corpo do erro em `ApiError.data` (3.º arg).
    const body = e.data as { error?: { code?: string } } | undefined;
    assertEquals(body?.error?.code, "COOLDOWN_ACTIVE");
  });

  it("re-invite depois da janela: invalida token anterior + cria novo", async () => {
    // Recuar o(s) invite(s) para além da janela de cooldown (8 > 7 dias) faz o
    // guard passar - sem isto o reenvio devolveria 422 (ver teste acima). Só o
    // `created_at` do token invite conta para o cooldown (purpose='invite').
    await sql`
      UPDATE core.invite_token
         SET created_at = NOW() - INTERVAL '8 days'
       WHERE user_id = (SELECT user_id FROM core.occupant WHERE id = ${occWithEmailId})
         AND purpose = 'invite'
    `;

    const { data, status } = await inviteByOccupant(condoA.id, occWithEmailId, headersA);
    assertEquals(status, 201);
    assertEquals(data.sentTo, emailA);

    // Só 1 token ativo (não-usado, não-expirado). O anterior foi
    // marcado como `used_at = now()` pelo helper para invalidar.
    const rows = await sql<{ active: number; total: number }[]>`
      SELECT
        COUNT(*) FILTER (WHERE used_at IS NULL AND expires_at > NOW())::int AS active,
        COUNT(*)::int AS total
        FROM core.invite_token
       WHERE user_id = (SELECT user_id FROM core.occupant WHERE id = ${occWithEmailId})
         AND purpose = 'invite'
    `;
    assertEquals(rows[0].active, 1);
    assertGreater(rows[0].total, 1);
  });

  it("projeção do user: inviteInCooldown + inviteCooldownUntil refletem a janela", async () => {
    // O reenvio anterior deixou o convite dentro da janela -> badge ligado.
    const inWin = await client.admin.getUser(invitedUserId, { headers: headersA });
    assertEquals(inWin.data.inviteInCooldown, true);
    assertEquals(typeof inWin.data.inviteCooldownUntil, "string");

    // Recuar o convite para fora da janela -> badge desliga. É a MESMA fonte do
    // 422 (isInInviteResendCooldown), por isso badge e enforcement nunca divergem.
    await sql`
      UPDATE core.invite_token SET created_at = NOW() - INTERVAL '8 days'
       WHERE user_id = ${invitedUserId} AND purpose = 'invite'
    `;
    const outWin = await client.admin.getUser(invitedUserId, { headers: headersA });
    assertEquals(outWin.data.inviteInCooldown, false);
    assertEquals(outWin.data.inviteCooldownUntil, null);
  });

  it("cooldown conta só purpose='invite' (token de reset não reactiva, ADR 0032)", async () => {
    // Convite fora da janela (recuado) + um token de RESET recente.
    // `loadLastInvitedAt` filtra purpose='invite', por isso o reset NÃO conta
    // e o reenvio é permitido - senão um reset de password bloqueava convites.
    await sql`
      UPDATE core.invite_token SET created_at = NOW() - INTERVAL '8 days'
       WHERE user_id = ${invitedUserId} AND purpose = 'invite'
    `;
    await sql`
      INSERT INTO core.invite_token (token, user_id, purpose, expires_at, created_at)
      VALUES (${`tok_reset_${stamp}`}, ${invitedUserId}, 'reset', NOW() + INTERVAL '1 day', NOW())
    `;
    const { status } = await inviteByOccupant(condoA.id, occWithEmailId, headersA);
    assertEquals(status, 201);
  });

  it("400 quando occupant não tem email", async () => {
    const e = await assertRejects(
      () => inviteByOccupant(condoA.id, occNoEmailId, headersA),
      ApiError,
    );
    assertEquals(e.statusCode, 400);
  });

  it("404 quando occupant é doutro condo (multi-tenant)", async () => {
    const e = await assertRejects(
      () => inviteByOccupant(condoA.id, occInBId, headersA),
      ApiError,
    );
    assertEquals(e.statusCode, 404);
  });

  it("404 quando occupantId inexistente", async () => {
    const e = await assertRejects(
      () => inviteByOccupant(condoA.id, "ghostxyz12", headersA),
      ApiError,
    );
    assertEquals(e.statusCode, 404);
  });

  it("teardown", async () => {
    try {
      await sql`DELETE FROM core.user WHERE email IN (${emailA}, ${emailB})`;
    } finally {
      await sql.end();
    }
  });
});
