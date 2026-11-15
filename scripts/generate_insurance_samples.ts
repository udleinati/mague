// Gerador de variantes do email "lembrete de seguro" para revisão visual.
//
// Uso:
//   deno run --allow-write=/tmp scripts/generate_insurance_samples.ts
//
// Resultado: 10 ficheiros HTML em /tmp/email_samples/insurance_reminder_NN_*.html
// para comparar lado-a-lado com o template actual gerado por
// generate_email_samples.ts.
//
// Cada variante explora uma direcção de design distinta (formal/cordial/seco,
// serif/sans, com/sem marca Mague) - para o utilizador escolher qual o tom
// apropriado para a comunicação chegar ao condómino como "voz da
// administração", não da Mague.

const OUT_DIR = "/tmp/email_samples";

interface Params {
  recipientName: string;
  condominiumName: string;
  unitDesignation: string;
  portalUrl: string;
}

const params: Params = {
  recipientName: "Pedro Santos",
  condominiumName: "Edifício Atlântico",
  unitDesignation: "3º A",
  portalUrl: "https://app.mague.pt/portal/c/cdAtl/u/u03A/insurances",
};

function escapeHtml(s: string): string {
  return s.replace(
    /[&<>"']/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!),
  );
}

function wrapWithMeta(subject: string, label: string, html: string): string {
  return `<!doctype html>
<html lang="pt">
<head>
  <meta charset="utf-8">
  <title>${subject}</title>
  <style>
    body { margin: 0; background: #f5f5f5; font-family: -apple-system, sans-serif; }
    .meta {
      max-width: 560px;
      margin: 32px auto 0;
      padding: 12px 16px;
      background: #fff7ed;
      border: 1px solid #fed7aa;
      border-radius: 8px;
      font-size: 13px;
      color: #7c2d12;
    }
    .meta strong { color: #431407; }
    .meta .label { font-weight: 700; color: #431407; }
    .email-wrap {
      max-width: 600px;
      margin: 16px auto 32px;
      background: white;
      border: 1px solid #e5e7eb;
      border-radius: 12px;
      box-shadow: 0 1px 3px rgba(0,0,0,0.05);
      overflow: hidden;
    }
  </style>
</head>
<body>
  <div class="meta">
    <div><span class="label">${label}</span> · sample preview, sem envio real</div>
    <div>Subject: <code>${subject}</code></div>
  </div>
  <div class="email-wrap">
    ${html}
  </div>
</body>
</html>`;
}

interface Variant {
  slug: string;
  label: string;
  subject: string;
  html: string;
}

// ─── 01 · Sóbrio, condomínio em destaque ───────────────────────────────────
function variant01(p: Params): Variant {
  return {
    slug: "sobrio",
    label: "01 · Sóbrio, condomínio em destaque",
    subject: `Apólice de seguro em falta - ${p.condominiumName}`,
    html: `
    <div style="font-family:-apple-system,BlinkMacSystemFont,sans-serif;max-width:560px;margin:0 auto;padding:36px 28px;color:#1a1a1a;">
      <div style="text-align:center;margin-bottom:32px;padding-bottom:20px;border-bottom:2px solid #1f2937;">
        <div style="font-size:11px;letter-spacing:2px;color:#6b7280;text-transform:uppercase;margin-bottom:6px;">Condomínio</div>
        <div style="font-size:22px;font-weight:800;color:#111827;letter-spacing:-0.3px;text-transform:uppercase;">${
      escapeHtml(p.condominiumName)
    }</div>
      </div>
      <p style="font-size:15px;line-height:1.6;margin:0 0 16px;color:#1f2937;">
        Caro(a) <strong>${escapeHtml(p.recipientName)}</strong>,
      </p>
      <p style="font-size:14px;line-height:1.7;margin:0 0 16px;color:#374151;">
        Verificámos que a fracção <strong>${escapeHtml(p.unitDesignation)}</strong> não tem
        actualmente apólice de seguro válida registada nos nossos serviços.
      </p>
      <p style="font-size:14px;line-height:1.7;margin:0 0 24px;color:#374151;">
        Solicitamos que submeta o PDF da apólice no portal do condomínio. Basta
        carregar o ficheiro - o sistema extrai os dados automaticamente.
      </p>
      <div style="text-align:center;margin:32px 0;">
        <a href="${p.portalUrl}"
           style="display:inline-block;background:#111827;color:white;text-decoration:none;
                  padding:13px 36px;border-radius:6px;font-weight:600;font-size:15px;">
          Submeter apólice
        </a>
      </div>
      <p style="font-size:14px;line-height:1.7;margin:32px 0 0;color:#374151;">
        Os melhores cumprimentos,<br>
        <strong>A Administração</strong>
      </p>
      <p style="font-size:12px;line-height:1.6;color:#9ca3af;margin:32px 0 0;border-top:1px solid #e5e7eb;padding-top:16px;">
        Caso já tenha submetido recentemente, ignore este aviso.<br>
        Link directo: <span style="color:#6b7280;word-break:break-all;">${p.portalUrl}</span>
      </p>
    </div>
  `,
  };
}

// ─── 02 · Carta formal clássica ────────────────────────────────────────────
function variant02(p: Params): Variant {
  return {
    slug: "carta_formal",
    label: "02 · Carta formal clássica",
    subject: `Apólice de seguro da fracção ${p.unitDesignation} - ${p.condominiumName}`,
    html: `
    <div style="font-family:Georgia,'Times New Roman',serif;max-width:560px;margin:0 auto;padding:44px 36px;color:#1a1a1a;">
      <div style="text-align:center;margin-bottom:36px;">
        <div style="font-size:24px;font-weight:600;color:#1a1a1a;letter-spacing:0.5px;">${
      escapeHtml(p.condominiumName)
    }</div>
        <div style="margin-top:10px;height:1px;background:linear-gradient(to right, transparent, #b08d57, transparent);"></div>
        <div style="font-size:11px;letter-spacing:3px;color:#6b7280;text-transform:uppercase;margin-top:10px;">Administração de Condomínio</div>
      </div>
      <p style="font-size:15px;line-height:1.7;margin:0 0 20px;color:#1f2937;">
        Exmo(a). Senhor(a) <strong>${escapeHtml(p.recipientName)}</strong>,
      </p>
      <p style="font-size:14px;line-height:1.85;margin:0 0 16px;color:#374151;text-align:justify;">
        Vimos pela presente comunicação informar V. Exa. de que, na nossa base
        de registos, a fracção autónoma <strong>${escapeHtml(p.unitDesignation)}</strong>
        deste edifício não consta de apólice de seguro válida.
      </p>
      <p style="font-size:14px;line-height:1.85;margin:0 0 16px;color:#374151;text-align:justify;">
        Tratando-se de uma obrigação legal e estatutária, agradecemos a
        regularização da situação com a brevidade possível.
      </p>
      <p style="font-size:14px;line-height:1.85;margin:0 0 24px;color:#374151;text-align:justify;">
        Para o efeito, basta submeter cópia digital da apólice (em formato PDF)
        no portal do condomínio através do botão abaixo, indicando a
        respectiva data de validade.
      </p>
      <div style="text-align:center;margin:36px 0;">
        <a href="${p.portalUrl}"
           style="display:inline-block;background:#1a1a1a;color:white;text-decoration:none;
                  padding:12px 32px;border-radius:2px;font-weight:500;font-size:14px;letter-spacing:0.5px;font-family:Georgia,serif;">
          Submeter apólice no portal
        </a>
      </div>
      <p style="font-size:14px;line-height:1.7;margin:36px 0 0;color:#374151;">
        Com os melhores cumprimentos,<br><br>
        <strong style="font-size:15px;">A Administração do Condomínio</strong><br>
        <span style="color:#6b7280;font-size:13px;font-style:italic;">${
      escapeHtml(p.condominiumName)
    }</span>
      </p>
      <p style="font-size:11px;line-height:1.6;color:#9ca3af;margin:40px 0 0;border-top:1px solid #d1d5db;padding-top:14px;font-style:italic;">
        Em caso de submissão recente, agradecemos que ignore esta comunicação.
      </p>
    </div>
  `,
  };
}

// ─── 03 · Tipografia serif elegante ────────────────────────────────────────
function variant03(p: Params): Variant {
  return {
    slug: "serif_elegante",
    label: "03 · Tipografia serif elegante (creme)",
    subject: `Apólice de seguro - ${p.condominiumName}`,
    html: `
    <div style="font-family:Georgia,'Times New Roman',serif;max-width:560px;margin:0 auto;padding:44px 32px;background:#fdfbf7;color:#3d2817;">
      <div style="text-align:center;margin-bottom:40px;">
        <div style="font-size:28px;font-weight:400;color:#3d2817;letter-spacing:-0.5px;font-style:italic;">${
      escapeHtml(p.condominiumName)
    }</div>
      </div>
      <h1 style="font-size:18px;font-weight:600;margin:0 0 16px;color:#3d2817;">Caro(a) ${
      escapeHtml(p.recipientName)
    },</h1>
      <p style="font-size:15px;line-height:1.8;margin:0 0 16px;color:#5b4530;">
        Vimos lembrar que a fracção <strong>${escapeHtml(p.unitDesignation)}</strong> não
        apresenta apólice de seguro em vigor no nosso registo.
      </p>
      <p style="font-size:15px;line-height:1.8;margin:0 0 28px;color:#5b4530;">
        Pedimos a gentileza de submeter cópia da apólice no portal do
        condomínio, onde poderá fazê-lo em poucos minutos.
      </p>
      <div style="text-align:center;margin:36px 0;">
        <a href="${p.portalUrl}"
           style="display:inline-block;background:transparent;color:#3d2817;text-decoration:none;
                  padding:11px 30px;border:1.5px solid #3d2817;font-weight:600;font-size:14px;letter-spacing:0.8px;font-family:Georgia,serif;">
          SUBMETER APÓLICE
        </a>
      </div>
      <p style="font-size:15px;line-height:1.7;margin:40px 0 0;color:#5b4530;">
        Cordialmente,<br>
        <em style="font-size:16px;color:#3d2817;">A Administração</em>
      </p>
      <p style="font-size:11px;line-height:1.6;color:#a08868;margin:36px 0 0;border-top:1px solid #e8dfd0;padding-top:14px;font-style:italic;">
        Caso a apólice já tenha sido submetida, agradecemos que ignore este aviso.
      </p>
    </div>
  `,
  };
}

// ─── 04 · Voz da administração + selo Mague subtil no rodapé ───────────────
function variant04(p: Params): Variant {
  return {
    slug: "admin_voz_mague_subtil",
    label: "04 · Voz da administração + selo Mague subtil",
    subject: `Apólice de seguro em falta - fracção ${p.unitDesignation}`,
    html: `
    <div style="font-family:-apple-system,BlinkMacSystemFont,sans-serif;max-width:560px;margin:0 auto;padding:32px 24px;color:#1a1a1a;">
      <div style="margin-bottom:28px;">
        <div style="font-size:11px;letter-spacing:2px;color:#9ca3af;text-transform:uppercase;margin-bottom:4px;">Condomínio</div>
        <div style="font-size:20px;font-weight:700;color:#111827;">${
      escapeHtml(p.condominiumName)
    }</div>
      </div>
      <h1 style="font-size:18px;margin:0 0 14px;color:#111827;">Olá, ${
      escapeHtml(p.recipientName)
    }</h1>
      <p style="font-size:14px;line-height:1.7;margin:0 0 16px;color:#374151;">
        A fracção <strong>${escapeHtml(p.unitDesignation)}</strong> não tem actualmente
        apólice de seguro válida registada.
      </p>
      <p style="font-size:14px;line-height:1.7;margin:0 0 24px;color:#374151;">
        Pode submeter o PDF da apólice no portal - o sistema lê os dados
        automaticamente, basta confirmar a data de validade.
      </p>
      <div style="margin:28px 0;">
        <a href="${p.portalUrl}"
           style="display:inline-block;background:#0d9488;color:white;text-decoration:none;
                  padding:12px 28px;border-radius:6px;font-weight:600;font-size:14px;">
          Submeter apólice
        </a>
      </div>
      <p style="font-size:14px;line-height:1.7;margin:32px 0 0;color:#374151;">
        Os melhores cumprimentos,<br>
        <strong>A Administração</strong>
      </p>
      <p style="font-size:11px;line-height:1.5;color:#9ca3af;margin:32px 0 0;border-top:1px solid #e5e7eb;padding-top:14px;">
        Comunicação automática enviada através da plataforma <strong style="color:#6b7280;">Mague</strong>.<br>
        <span style="word-break:break-all;">${p.portalUrl}</span>
      </p>
    </div>
  `,
  };
}

// ─── 05 · Estilo carta com morada e data ───────────────────────────────────
function variant05(p: Params): Variant {
  return {
    slug: "carta_morada_data",
    label: "05 · Carta com morada e data (papel timbrado)",
    subject: `${p.condominiumName} - apólice de seguro da fracção ${p.unitDesignation}`,
    html: `
    <div style="font-family:Georgia,'Times New Roman',serif;max-width:560px;margin:0 auto;padding:48px 40px;color:#1a1a1a;">
      <div style="margin-bottom:36px;">
        <div style="font-size:18px;font-weight:700;color:#1a1a1a;margin-bottom:6px;letter-spacing:0.3px;">${
      escapeHtml(p.condominiumName)
    }</div>
        <div style="font-size:13px;color:#6b7280;line-height:1.5;">
          Rua das Acácias, 12<br>
          1000-000 Lisboa
        </div>
      </div>
      <div style="text-align:right;font-size:13px;color:#374151;margin-bottom:32px;">
        Lisboa, 29 de Abril de 2026
      </div>
      <p style="font-size:14px;line-height:1.6;margin:0;color:#1f2937;">
        <strong>${escapeHtml(p.recipientName)}</strong>
      </p>
      <p style="font-size:13px;line-height:1.5;margin:0 0 28px;color:#6b7280;">
        Condómino da fracção ${escapeHtml(p.unitDesignation)}
      </p>
      <p style="font-size:14px;line-height:1.8;margin:0 0 16px;color:#1f2937;">
        Exmo(a). Senhor(a),
      </p>
      <p style="font-size:14px;line-height:1.85;margin:0 0 16px;color:#374151;text-align:justify;">
        Pelo presente comunicamos que a fracção <strong>${escapeHtml(p.unitDesignation)}</strong>
        não regista, à data, apólice de seguro em vigor.
      </p>
      <p style="font-size:14px;line-height:1.85;margin:0 0 24px;color:#374151;text-align:justify;">
        Solicitamos que proceda à submissão da apólice no portal do
        condomínio com a brevidade possível, através do link abaixo.
      </p>
      <div style="margin:32px 0;">
        <a href="${p.portalUrl}"
           style="display:inline-block;background:#1a1a1a;color:white;text-decoration:none;
                  padding:11px 28px;font-weight:500;font-size:14px;letter-spacing:0.3px;font-family:Georgia,serif;">
          Aceder ao portal
        </a>
      </div>
      <p style="font-size:14px;line-height:1.7;margin:40px 0 0;color:#1f2937;">
        Atentamente,<br><br><br>
        <strong>A Administração do ${escapeHtml(p.condominiumName)}</strong>
      </p>
    </div>
  `,
  };
}

// ─── 06 · Memorando / nota de serviço ──────────────────────────────────────
function variant06(p: Params): Variant {
  return {
    slug: "memorando",
    label: "06 · Memorando / nota de serviço",
    subject: `[${p.condominiumName}] Apólice de seguro em falta - fracção ${p.unitDesignation}`,
    html: `
    <div style="font-family:-apple-system,BlinkMacSystemFont,sans-serif;max-width:560px;margin:0 auto;padding:32px 24px;color:#1a1a1a;">
      <div style="border:2px solid #1f2937;padding:18px 22px;margin-bottom:24px;background:#f9fafb;">
        <div style="font-size:11px;letter-spacing:2px;color:#6b7280;text-transform:uppercase;font-weight:700;margin-bottom:14px;border-bottom:1px solid #d1d5db;padding-bottom:8px;">Comunicação da Administração</div>
        <table style="width:100%;font-size:13px;color:#1f2937;border-collapse:collapse;">
          <tr><td style="padding:4px 0;width:80px;color:#6b7280;font-weight:600;">DE:</td><td style="padding:4px 0;font-weight:600;">A Administração - ${
      escapeHtml(p.condominiumName)
    }</td></tr>
          <tr><td style="padding:4px 0;color:#6b7280;font-weight:600;">PARA:</td><td style="padding:4px 0;font-weight:600;">${
      escapeHtml(p.recipientName)
    } (fracção ${escapeHtml(p.unitDesignation)})</td></tr>
          <tr><td style="padding:4px 0;color:#6b7280;font-weight:600;">DATA:</td><td style="padding:4px 0;">29 de Abril de 2026</td></tr>
          <tr><td style="padding:4px 0;color:#6b7280;font-weight:600;">ASSUNTO:</td><td style="padding:4px 0;font-weight:600;">Apólice de seguro em falta</td></tr>
        </table>
      </div>
      <p style="font-size:14px;line-height:1.7;margin:0 0 14px;color:#1f2937;">
        Constatou-se a ausência de apólice de seguro válida associada à
        fracção <strong>${escapeHtml(p.unitDesignation)}</strong> na base de registos do
        condomínio.
      </p>
      <p style="font-size:14px;line-height:1.7;margin:0 0 14px;color:#1f2937;">
        <strong>Acção requerida:</strong> submissão de cópia da apólice em vigor.
      </p>
      <p style="font-size:14px;line-height:1.7;margin:0 0 14px;color:#1f2937;">
        <strong>Procedimento:</strong> aceder ao portal do condomínio através
        do link abaixo e carregar o ficheiro PDF da apólice.
      </p>
      <div style="margin:24px 0;">
        <a href="${p.portalUrl}"
           style="display:inline-block;background:#1f2937;color:white;text-decoration:none;
                  padding:10px 24px;border-radius:3px;font-weight:600;font-size:13px;text-transform:uppercase;letter-spacing:0.5px;">
          Aceder ao portal
        </a>
      </div>
      <p style="font-size:13px;line-height:1.7;margin:36px 0 0;color:#374151;border-top:1px solid #e5e7eb;padding-top:16px;">
        <strong>A Administração</strong><br>
        <span style="color:#6b7280;">${escapeHtml(p.condominiumName)}</span>
      </p>
    </div>
  `,
  };
}

// ─── 07 · Tom próximo + assinatura institucional ───────────────────────────
function variant07(p: Params): Variant {
  return {
    slug: "tom_proximo",
    label: "07 · Tom próximo, assinatura institucional",
    subject: `Pedro, falta a apólice da ${p.unitDesignation}`,
    html: `
    <div style="font-family:-apple-system,BlinkMacSystemFont,sans-serif;max-width:560px;margin:0 auto;padding:32px 24px;color:#1a1a1a;">
      <div style="margin-bottom:28px;text-align:center;">
        <div style="display:inline-block;padding:10px 22px;background:#fef3c7;border-radius:24px;font-size:13px;font-weight:600;color:#78350f;">
          ${escapeHtml(p.condominiumName)}
        </div>
      </div>
      <h1 style="font-size:22px;margin:0 0 16px;color:#111827;">Olá, ${
      escapeHtml(p.recipientName)
    }!</h1>
      <p style="font-size:15px;line-height:1.7;margin:0 0 16px;color:#374151;">
        Estamos a escrever-lhe porque reparámos que a fracção
        <strong>${escapeHtml(p.unitDesignation)}</strong> ainda não tem apólice de seguro
        registada no portal.
      </p>
      <p style="font-size:15px;line-height:1.7;margin:0 0 24px;color:#374151;">
        Como sabe, é uma obrigação legal - e queremos ajudá-lo(a) a tratar
        disto sem complicações. Basta carregar o PDF no portal e o sistema
        trata do resto.
      </p>
      <div style="text-align:center;margin:32px 0;">
        <a href="${p.portalUrl}"
           style="display:inline-block;background:#0891b2;color:white;text-decoration:none;
                  padding:13px 32px;border-radius:8px;font-weight:600;font-size:15px;">
          Submeter apólice
        </a>
      </div>
      <p style="font-size:14px;line-height:1.7;margin:32px 0 0;color:#374151;">
        Obrigado pela colaboração.<br><br>
        Cumprimentos,<br>
        <strong>A Administração do ${escapeHtml(p.condominiumName)}</strong>
      </p>
      <p style="font-size:12px;line-height:1.6;color:#9ca3af;margin:24px 0 0;border-top:1px solid #e5e7eb;padding-top:14px;">
        Já submeteu? Ignore este lembrete - pode estar em revisão.
      </p>
    </div>
  `,
  };
}

// ─── 08 · Paleta azul-marinho institucional ────────────────────────────────
function variant08(p: Params): Variant {
  return {
    slug: "navy_institucional",
    label: "08 · Paleta azul-marinho institucional",
    subject: `Apólice de seguro - ${p.condominiumName}`,
    html: `
    <div style="font-family:-apple-system,BlinkMacSystemFont,sans-serif;max-width:560px;margin:0 auto;color:#1a1a1a;">
      <div style="background:#1e3a8a;color:white;padding:30px 24px;text-align:center;">
        <div style="display:inline-block;width:40px;height:40px;border:2px solid white;border-radius:6px;line-height:36px;font-size:14px;font-weight:900;letter-spacing:-0.5px;margin-bottom:10px;">EA</div>
        <div style="font-size:18px;font-weight:700;letter-spacing:0.3px;">${
      escapeHtml(p.condominiumName)
    }</div>
        <div style="font-size:11px;letter-spacing:2px;text-transform:uppercase;color:#bfdbfe;margin-top:4px;">Administração</div>
      </div>
      <div style="padding:32px 28px;">
        <h1 style="font-size:18px;margin:0 0 16px;color:#1e3a8a;">Lembrete: apólice de seguro</h1>
        <p style="font-size:14px;line-height:1.7;margin:0 0 14px;color:#1f2937;">
          Caro(a) <strong>${escapeHtml(p.recipientName)}</strong>,
        </p>
        <p style="font-size:14px;line-height:1.7;margin:0 0 16px;color:#374151;">
          A fracção <strong>${escapeHtml(p.unitDesignation)}</strong> não dispõe, no nosso
          registo, de apólice de seguro válida.
        </p>
        <p style="font-size:14px;line-height:1.7;margin:0 0 24px;color:#374151;">
          Solicitamos que submeta o PDF da apólice no portal do condomínio.
        </p>
        <div style="text-align:center;margin:28px 0;">
          <a href="${p.portalUrl}"
             style="display:inline-block;background:#1e3a8a;color:white;text-decoration:none;
                    padding:12px 32px;border-radius:6px;font-weight:600;font-size:14px;">
            Submeter apólice
          </a>
        </div>
        <p style="font-size:14px;line-height:1.7;margin:32px 0 0;color:#374151;">
          Os melhores cumprimentos,<br>
          <strong style="color:#1e3a8a;">A Administração</strong>
        </p>
        <p style="font-size:11px;line-height:1.6;color:#9ca3af;margin:24px 0 0;border-top:1px solid #e5e7eb;padding-top:14px;">
          Caso já tenha submetido, ignore esta comunicação.
        </p>
      </div>
    </div>
  `,
  };
}

// ─── 09 · Aviso aos condóminos (estilo edital) ─────────────────────────────
function variant09(p: Params): Variant {
  return {
    slug: "aviso_edital",
    label: "09 · Aviso aos condóminos (edital, formal)",
    subject: `AVISO - Apólice de seguro da fracção ${p.unitDesignation}`,
    html: `
    <div style="font-family:-apple-system,BlinkMacSystemFont,sans-serif;max-width:560px;margin:0 auto;color:#1a1a1a;">
      <div style="background:#7c2d12;color:white;padding:24px;text-align:center;">
        <div style="font-size:11px;letter-spacing:3px;text-transform:uppercase;opacity:0.9;margin-bottom:6px;">Aviso aos condóminos</div>
        <div style="font-size:20px;font-weight:800;letter-spacing:-0.3px;">${
      escapeHtml(p.condominiumName)
    }</div>
      </div>
      <div style="padding:32px 28px;">
        <p style="font-size:14px;line-height:1.7;margin:0 0 16px;color:#1f2937;">
          <strong>Exmo(a). Condómino(a) ${escapeHtml(p.recipientName)},</strong>
        </p>
        <p style="font-size:14px;line-height:1.85;margin:0 0 16px;color:#374151;text-align:justify;">
          Vimos por este meio chamar a atenção de V. Exa. para a inexistência
          de apólice de seguro válida sobre a fracção autónoma
          <strong>${escapeHtml(p.unitDesignation)}</strong>, conforme registos da Administração
          do Condomínio.
        </p>
        <p style="font-size:14px;line-height:1.85;margin:0 0 16px;color:#374151;text-align:justify;">
          Nos termos do disposto no artigo 1429.º do Código Civil, é
          obrigatório o seguro contra o risco de incêndio sobre cada uma das
          fracções autónomas e sobre as partes comuns do edifício.
        </p>
        <p style="font-size:14px;line-height:1.85;margin:0 0 24px;color:#374151;text-align:justify;">
          Solicita-se assim a regularização da situação no mais curto prazo,
          através da submissão da apólice no portal do condomínio.
        </p>
        <div style="text-align:center;margin:28px 0;padding:18px;background:#fef3c7;border-left:4px solid #d97706;">
          <a href="${p.portalUrl}"
             style="display:inline-block;background:#7c2d12;color:white;text-decoration:none;
                    padding:12px 32px;border-radius:4px;font-weight:600;font-size:14px;">
            Regularizar no portal
          </a>
        </div>
        <p style="font-size:14px;line-height:1.7;margin:32px 0 0;color:#374151;">
          <strong>A Administração do Condomínio</strong><br>
          <span style="font-size:13px;color:#6b7280;">${escapeHtml(p.condominiumName)}</span>
        </p>
      </div>
    </div>
  `,
  };
}

// ─── 10 · Minimal moderno ──────────────────────────────────────────────────
function variant10(p: Params): Variant {
  return {
    slug: "minimal_moderno",
    label: "10 · Minimal moderno (sem logo, espaço branco)",
    subject: `Lembrete de apólice - fracção ${p.unitDesignation}`,
    html: `
    <div style="font-family:-apple-system,BlinkMacSystemFont,sans-serif;max-width:480px;margin:0 auto;padding:56px 28px;color:#1a1a1a;">
      <div style="font-size:12px;color:#9ca3af;margin-bottom:48px;letter-spacing:0.2px;">
        De: <span style="color:#1f2937;font-weight:500;">${escapeHtml(p.condominiumName)}</span>
      </div>
      <h1 style="font-size:26px;font-weight:600;margin:0 0 28px;color:#111827;letter-spacing:-0.5px;line-height:1.3;">
        Lembrete de apólice
      </h1>
      <p style="font-size:15px;line-height:1.7;margin:0 0 20px;color:#4b5563;">
        ${escapeHtml(p.recipientName)},
      </p>
      <p style="font-size:15px;line-height:1.7;margin:0 0 20px;color:#4b5563;">
        A fracção ${escapeHtml(p.unitDesignation)} não tem apólice de seguro registada.
      </p>
      <p style="font-size:15px;line-height:1.7;margin:0 0 40px;color:#4b5563;">
        Pode submeter o PDF no portal do condomínio.
      </p>
      <a href="${p.portalUrl}"
         style="display:inline-block;font-size:15px;color:#111827;text-decoration:none;border-bottom:2px solid #111827;padding-bottom:3px;font-weight:500;">
        Submeter apólice
      </a>
      <p style="font-size:14px;line-height:1.7;margin:72px 0 0;color:#4b5563;">
        - A Administração
      </p>
      <p style="font-size:12px;line-height:1.6;color:#9ca3af;margin:48px 0 0;">
        <span style="word-break:break-all;">${p.portalUrl}</span>
      </p>
    </div>
  `,
  };
}

const variants = [
  variant01,
  variant02,
  variant03,
  variant04,
  variant05,
  variant06,
  variant07,
  variant08,
  variant09,
  variant10,
];

await Deno.mkdir(OUT_DIR, { recursive: true });

const generated: string[] = [];
for (const [i, fn] of variants.entries()) {
  const v = fn(params);
  const num = String(i + 1).padStart(2, "0");
  const file = `${OUT_DIR}/insurance_reminder_${num}_${v.slug}.html`;
  await Deno.writeTextFile(file, wrapWithMeta(v.subject, v.label, v.html));
  generated.push(file);
}

console.log(`Geradas ${generated.length} variantes em ${OUT_DIR}:`);
for (const f of generated) console.log("  • " + f);
console.log("\nAbrir todas no browser:");
console.log(`  open ${OUT_DIR}/insurance_reminder_*.html`);
