// E2E security: CRLF / header injection no envio de emails.
//
// Threat: super (ou manager comprometido) cria condomínio com
// `name = "Cool Condo\r\nBcc: attacker@evil.com"` - quando esse nome é
// embebido em `subject` do email, nodemailer/SMTP poderiam interpretar
// o `\r\n` como separador de header e injectar headers maliciosos.
//
// Defesa: sendEmail() faz strip de \r\n em subject + to + bcc antes de
// passar para nodemailer. Como nem sempre conseguimos triggerar o envio
// real e ler os headers raw, validamos via audit.email_log que a row
// gravada já vem normalizada (sem \r\n).

import { assertEquals, assertNotEquals } from "@std/assert";
import { describe, it } from "@std/testing/bdd";
import postgresjs from "postgresjs";
import { Client, type Condominium } from "$shared/client/mod.ts";
import { loginAsSuper } from "./_helpers/auth.ts";

const BASE_URL = "http://localhost:3000";
const DATABASE_URL = Deno.env.get("DATABASE_URL") ??
  "postgres://mague:mague@localhost:5432/mague";
const AUTH = await loginAsSuper();
const client = new Client({ baseUrl: BASE_URL });
const sql = postgresjs(DATABASE_URL, { max: 2 });

describe("security - CRLF/header injection no email", () => {
  let condo: Condominium;
  const stamp = Date.now();
  // Subject crafted via condo name. \r\nBcc: ... = clássico CRLF injection.
  const maliciousName = `CRLF Test\r\nBcc: attacker-${stamp}@evil.com`;

  it("setup - condo com nome contendo \\r\\nBcc:", async () => {
    const { data } = await client.super.createCondominium(
      { name: maliciousName, fiscalNumber: "501555555" },
      { headers: AUTH },
    );
    condo = data;
    // Confirm: o nome foi guardado tal-e-qual (DB aceita CRLF). Não temos
    // CHECK constraint a impedir; o strip é defesa em profundidade no
    // ponto de uso (sendEmail).
    const row = await sql<{ name: string }[]>`
      SELECT name FROM core.condominium WHERE id = ${condo.id}
    `;
    assertEquals(row[0].name.includes("\r\n"), true);
  });

  it("trigger flux que envia email - audit.email_log row vem sem CRLF", async () => {
    // Trigger: forgot-password → mas isso é skip. Use invite/recibo flow.
    // Vamos simular um envio "manual" via insert directo na lib não dá -
    // melhor testar o path real. Forgot-password usa o condo.name como…
    // não, password_reset não loga. Vamos criar um occupant + invitar.
    const headers = { ...AUTH, "x-condominium-id": condo.id };
    const { data: u } = await client.super.createUnit(
      condo.id,
      { designation: "X", permillage: 1000 },
      { headers: AUTH },
    );
    const occEmail = `crlf-target-${stamp}@test.pt`;
    const { data: occ } = await client.admin.createOccupant(
      { name: "Target", type: "owner", email: occEmail, nif: "123456789" },
      { headers },
    );
    await client.admin.createUnitOccupant(
      u.id,
      {
        unitId: u.id,
        occupantId: occ.id as string,
        relationshipType: "owner",
        startDate: "2025-01-01",
      },
      { headers },
    );

    // Send invite - usa subject `Convite para o portal · ${condName}`.
    const res = await fetch(
      `${BASE_URL}/v1/admin/condominiums/${condo.id}/occupants/${occ.id}/invite`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json", ...AUTH },
        body: JSON.stringify({}),
      },
    );
    const txt = await res.text();
    if (!(res.status === 200 || res.status === 201)) {
      console.log("invite status", res.status, "body", txt.slice(0, 200));
    }
    assertEquals(res.status === 200 || res.status === 201, true);

    // Esperado: row em email_log com subject + recipient sem \r\n.
    const rows = await sql<{ subject: string; recipient: string; bcc: string | null }[]>`
      SELECT subject, recipient, bcc FROM audit.email_log
       WHERE condominium_id = ${condo.id}
         AND category = 'invite'
       ORDER BY created_at DESC LIMIT 1
    `;
    assertEquals(rows.length, 1);
    // Defesa: subject não pode conter \r ou \n após sendEmail.
    assertEquals(rows[0].subject.includes("\r"), false);
    assertEquals(rows[0].subject.includes("\n"), false);
    // Verifica que payload malicioso não passou para o subject - o resto
    // do nome ("CRLF Test") é OK; o que importa é não haver CRLF.
    assertNotEquals(
      rows[0].subject.includes("\r\nBcc:"),
      true,
      "subject contém CRLF - header injection possível",
    );
  });

  it("cleanup", async () => {
    try {
      await client.super.deleteCondominium(condo.id, { headers: AUTH });
    } finally {
      await sql.end();
    }
  });
});
