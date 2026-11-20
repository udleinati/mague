// Auth recovery flows: forgot-password, reset-password, accept-invite,
// change-password. Cobertura dos handlers em src/apps/api/modules/auth/.
//
// Estratégia de seed: insere user + invite_token diretamente em DB via
// docker exec (helper db.ts) - não há endpoint admin/super para criar
// utilizadores no fluxo regular (são criados via accept-invite).

import { assertEquals, assertRejects } from "@std/assert";
import { describe, it } from "@std/testing/bdd";
import { ApiError, Client } from "$shared/client/mod.ts";
import { deleteTestUser, seedInviteToken, seedTestUser, sqlExec } from "./_helpers/db.ts";

const BASE_URL = "http://localhost:3000";
const client = new Client({ baseUrl: BASE_URL });

describe("auth recovery - forgot/reset/accept-invite/change-password", () => {
  // ─── forgot-password / reset-password ───────────────────────────────
  describe("forgot-password + reset-password", () => {
    const userId = "usr_recov_reset";
    const email = `${userId}@test.pt`;

    it("setup: cria user de teste", async () => {
      await deleteTestUser(userId).catch(() => {});
      await seedTestUser({ id: userId, email, password: "old-pass-123" });
    });

    it("forgot-password com identifier inexistente devolve 204 (não vaza)", async () => {
      // Cliente devolve void (204); sucesso = não atira.
      await client.auth.forgotPassword("nao-existe@nada.pt");
    });

    it("forgot-password com email válido cria token de reset em DB", async () => {
      // Limpa tokens prévios para isolar este teste.
      await sqlExec(`DELETE FROM core.invite_token WHERE user_id = '${userId}'`);
      await client.auth.forgotPassword(email);
      const count = await sqlExec(`
        SELECT count(*) FROM core.invite_token
        WHERE user_id='${userId}' AND purpose='reset' AND used_at IS NULL
      `);
      assertEquals(count, "1");
    });

    it("reset-password com token inválido devolve 410", async () => {
      const e = await assertRejects(
        () => client.auth.resetPassword("token-fake-inexistente", "nova-pass-12345"),
        ApiError,
      );
      assertEquals(e.statusCode, 410);
    });

    it("reset-password com password curta devolve 400", async () => {
      const e = await assertRejects(
        () => client.auth.resetPassword("qualquer", "curt"),
        ApiError,
      );
      assertEquals(e.statusCode, 400);
    });

    it("reset-password happy path: password muda + sessão criada", async () => {
      const token = "reset-tok-" + crypto.randomUUID();
      await seedInviteToken({ token, userId, purpose: "reset", ttlSeconds: 3600 });

      const { data, status } = await client.auth.resetPassword(token, "nova-pass-12345");
      assertEquals(status, 200);
      assertEquals(typeof data.token, "string");
      assertEquals(data.user.email, email);

      // Login com password nova funciona
      const { data: loginData } = await client.auth.login(email, "nova-pass-12345");
      assertEquals(loginData.user.id, userId);
    });

    it("reset-password popula first/last_login_at (reset com sessão É um login)", async () => {
      // User isolado que NUNCA fez login: garante que o tracking vem do reset
      // e não de um /login posterior (o happy path acima faz login e mascararia).
      // Regressão: o reset cria sessão imediata, logo tem que registar o acesso -
      // senão um condómino que entra via "esqueci-me da password" fica sem datas.
      const trackId = "usr_recov_reset_track";
      const trackEmail = `${trackId}@test.pt`;
      await deleteTestUser(trackId).catch(() => {});
      await seedTestUser({ id: trackId, email: trackEmail, password: "old-pass-123" });

      const before = await sqlExec(
        `SELECT first_login_at IS NULL AND last_login_at IS NULL FROM core."user" WHERE id='${trackId}'`,
      );
      assertEquals(before, "t");

      const token = "reset-track-" + crypto.randomUUID();
      await seedInviteToken({ token, userId: trackId, purpose: "reset", ttlSeconds: 3600 });
      await client.auth.resetPassword(token, "nova-pass-track-123");

      // Sem qualquer /login: o reset sozinho tem que ter registado o acesso.
      const after = await sqlExec(
        `SELECT first_login_at IS NOT NULL AND last_login_at IS NOT NULL FROM core."user" WHERE id='${trackId}'`,
      );
      assertEquals(after, "t");

      // first_login_at é write-once: um 2º reset preserva-o.
      const firstTs = await sqlExec(
        `SELECT first_login_at FROM core."user" WHERE id='${trackId}'`,
      );
      const token2 = "reset-track2-" + crypto.randomUUID();
      await seedInviteToken({ token: token2, userId: trackId, purpose: "reset", ttlSeconds: 3600 });
      await client.auth.resetPassword(token2, "nova-pass-track-456");
      const firstTs2 = await sqlExec(
        `SELECT first_login_at FROM core."user" WHERE id='${trackId}'`,
      );
      assertEquals(firstTs, firstTs2);

      await deleteTestUser(trackId);
    });

    it("reset-password com mesmo token (já usado) devolve 410", async () => {
      const token = "reset-tok-once-" + crypto.randomUUID();
      await seedInviteToken({ token, userId, purpose: "reset" });
      await client.auth.resetPassword(token, "uso-1-pass-123");

      const e = await assertRejects(
        () => client.auth.resetPassword(token, "uso-2-pass-123"),
        ApiError,
      );
      assertEquals(e.statusCode, 410);
    });

    it("forgot-password invalida tokens reset anteriores", async () => {
      // Cria 2 tokens reset; segundo forgotPassword tem que invalidar o primeiro.
      const t1 = "reset-old-" + crypto.randomUUID();
      await seedInviteToken({ token: t1, userId, purpose: "reset" });

      await client.auth.forgotPassword(email);
      const used = await sqlExec(
        `SELECT used_at IS NOT NULL FROM core.invite_token WHERE token='${t1}'`,
      );
      assertEquals(used, "t");
    });

    it("teardown", async () => {
      await deleteTestUser(userId);
    });
  });

  // ─── accept-invite ──────────────────────────────────────────────────
  describe("accept-invite", () => {
    const userId = "usr_recov_invite";
    const email = `${userId}@test.pt`;

    it("setup: user + invite token", async () => {
      await deleteTestUser(userId).catch(() => {});
      await seedTestUser({ id: userId, email });
    });

    it("preview de token inválido devolve 410", async () => {
      const res = await fetch(`${BASE_URL}/v1/auth/invite/token-inexistente`);
      assertEquals(res.status, 410);
      await res.body?.cancel();
    });

    it("previewInvite (client) com token válido devolve dados do user", async () => {
      const token = "invite-preview-" + crypto.randomUUID();
      await seedInviteToken({ token, userId, purpose: "invite", ttlSeconds: 86400 });

      const { data, status } = await client.auth.previewInvite(token);
      assertEquals(status, 200);
      assertEquals(data.purpose, "invite");
      assertEquals(data.user.email, email);
      // expiresAt é uma data ISO no futuro.
      assertEquals(typeof data.expiresAt, "string");
      assertEquals(new Date(data.expiresAt).getTime() > Date.now(), true);
    });

    it("accept-invite happy path: define password, devolve sessão", async () => {
      const token = "invite-tok-" + crypto.randomUUID();
      await seedInviteToken({ token, userId, purpose: "invite", ttlSeconds: 86400 });

      const { data, status } = await client.auth.acceptInvite(token, "primeira-pass-123");
      assertEquals(status, 200);
      assertEquals(data.user.email, email);

      const isActive = await sqlExec(`SELECT is_active FROM core."user" WHERE id='${userId}'`);
      assertEquals(isActive, "t");
    });

    // Token de reset não leva email_log/BCC nem âmbito: só abre em /reset-password.
    it("accept-invite com token de reset devolve 410", async () => {
      const token = "reset-as-invite-" + crypto.randomUUID();
      await seedInviteToken({ token, userId, purpose: "reset" });
      const e = await assertRejects(
        () => client.auth.acceptInvite(token, "outra-pass-123"),
        ApiError,
      );
      assertEquals(e.statusCode, 410);
    });

    // `is_active` é do Super (ADR 0020): um convite por abrir não reativa a conta.
    it("accept-invite em conta inativa devolve 409 e a conta continua inativa", async () => {
      const inactiveId = "usr_recov_invite_inactive";
      await deleteTestUser(inactiveId).catch(() => {});
      await seedTestUser({ id: inactiveId, email: `${inactiveId}@test.pt`, active: false });
      const token = "invite-inactive-" + crypto.randomUUID();
      await seedInviteToken({ token, userId: inactiveId, purpose: "invite" });

      const e = await assertRejects(
        () => client.auth.acceptInvite(token, "nova-pass-123"),
        ApiError,
      );
      assertEquals(e.statusCode, 409);
      const isActive = await sqlExec(`SELECT is_active FROM core."user" WHERE id='${inactiveId}'`);
      assertEquals(isActive, "f");
      await deleteTestUser(inactiveId);
    });

    // O link do convite fica no email_log/BCC do condomínio: se a conta passou a
    // abrir algo fora do âmbito de quem convidou, o admin não pode tomá-la.
    it("accept-invite recusa (403) conta que já excede o âmbito de quem convidou", async () => {
      const superId = "usr_recov_invite_scope";
      await deleteTestUser(superId).catch(() => {});
      await seedTestUser({ id: superId, email: `${superId}@test.pt`, role: "super" });
      const token = "invite-scope-" + crypto.randomUUID();
      await seedInviteToken({
        token,
        userId: superId,
        purpose: "invite",
        scopeCondominiumIds: ["condo-de-quem-convidou"],
      });

      const e = await assertRejects(
        () => client.auth.acceptInvite(token, "tomada-pass-123"),
        ApiError,
      );
      assertEquals(e.statusCode, 403);
      const used = await sqlExec(
        `SELECT used_at IS NULL FROM core.invite_token WHERE token='${token}'`,
      );
      assertEquals(used, "t");
      await deleteTestUser(superId);
    });

    it("accept-invite com mesmo token (já usado) devolve 410", async () => {
      const token = "invite-once-" + crypto.randomUUID();
      await seedInviteToken({ token, userId, purpose: "invite" });
      await client.auth.acceptInvite(token, "primeira-12345");

      const e = await assertRejects(
        () => client.auth.acceptInvite(token, "outra-12345"),
        ApiError,
      );
      assertEquals(e.statusCode, 410);
    });

    it("teardown", async () => {
      await deleteTestUser(userId);
    });
  });

  // ─── change-password ────────────────────────────────────────────────
  describe("change-password", () => {
    const userId = "usr_recov_change";
    const email = `${userId}@test.pt`;
    const oldPass = "old-pass-12345";
    const newPass = "new-pass-67890";
    let token = "";

    it("setup: user ativo + login", async () => {
      await deleteTestUser(userId).catch(() => {});
      await seedTestUser({ id: userId, email, password: oldPass });
      const { data } = await client.auth.login(email, oldPass);
      token = data.token;
    });

    it("change-password sem auth devolve 401", async () => {
      const e = await assertRejects(
        () => client.auth.changePassword("", oldPass, newPass),
        ApiError,
      );
      assertEquals(e.statusCode, 401);
    });

    it("change-password com password atual errada devolve 401", async () => {
      const e = await assertRejects(
        () => client.auth.changePassword(token, "errada-12345", newPass),
        ApiError,
      );
      assertEquals(e.statusCode, 401);
    });

    it("change-password com nova password curta devolve 400", async () => {
      const e = await assertRejects(
        () => client.auth.changePassword(token, oldPass, "curta"),
        ApiError,
      );
      assertEquals(e.statusCode, 400);
    });

    it("change-password com mesma password (current = new) devolve 400", async () => {
      const e = await assertRejects(
        () => client.auth.changePassword(token, oldPass, oldPass),
        ApiError,
      );
      assertEquals(e.statusCode, 400);
    });

    it("change-password happy path: password muda, login com nova funciona", async () => {
      await client.auth.changePassword(token, oldPass, newPass);
      const { data } = await client.auth.login(email, newPass);
      assertEquals(data.user.id, userId);
    });

    it("teardown", async () => {
      await deleteTestUser(userId);
    });
  });
});
