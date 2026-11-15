// Testes unitários das funções puras dos helpers de convite. Só
// `buildAcceptInviteUrl` é testável sem BD; as outras vão por E2E em
// test_api/api_admin_occupant_invite_test.ts.

import { assertEquals } from "@std/assert";
import { buildAcceptInviteUrl } from "./_invite_helpers.ts";

Deno.test("buildAcceptInviteUrl - sem next devolve só o token", () => {
  const url = buildAcceptInviteUrl("https://app.mague.pt", "tok123");
  assertEquals(url, "https://app.mague.pt/accept-invite?token=tok123");
});

Deno.test("buildAcceptInviteUrl - com next inclui param adicional", () => {
  const url = buildAcceptInviteUrl(
    "https://app.mague.pt",
    "tok123",
    "/portal/c/cid/u/uid/receipts/r1",
  );
  // URLSearchParams encodifica `/` como `%2F`.
  assertEquals(
    url,
    "https://app.mague.pt/accept-invite?token=tok123&next=%2Fportal%2Fc%2Fcid%2Fu%2Fuid%2Freceipts%2Fr1",
  );
});

Deno.test("buildAcceptInviteUrl - encodifica caracteres especiais no token", () => {
  // O token nanoid usa A-Za-z0-9_- mas testamos defesa em profundidade.
  const url = buildAcceptInviteUrl("https://app.mague.pt", "a/b+c=d");
  assertEquals(url.includes("a%2Fb%2Bc%3Dd"), true);
});

Deno.test("buildAcceptInviteUrl - baseUrl sem trailing slash", () => {
  const url = buildAcceptInviteUrl("https://app.mague.pt", "tok");
  assertEquals(url.startsWith("https://app.mague.pt/"), true);
  assertEquals(url.includes("//accept-invite"), false);
});
