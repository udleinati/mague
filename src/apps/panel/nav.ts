// Fonte única dos destinos de navegação do admin.
//
// Consumida por:
//   - render.ts -> constrói o modelo por-request (interpola cid, marca o
//     `section` ativo, pendura o badge) e injeta como global `adminNav`.
//   - templates/partials/nav_desktop.vto + nav_drawer.vto -> renderizam o menu.
//   - templates/partials/command_palette.vto -> consome `adminNav.palette` (JSON).
//
// Mexer em NAV muda o menu E o palette ao mesmo tempo (sem drift). A TAXONOMIA
// (em que grupo cada item vive) está congelada de propósito: este módulo só
// passou a *gerar* o menu que já existia. Mover itens entre grupos é trabalho
// da reorganização (editar este array).

/** Item de navegação (definição estática). `path` é o sufixo após /admin/c/:cid. */
interface NavItemDef {
  label: string;
  section: string;
  path: string;
  /** Sinónimos do CONTEXT.md para o palette encontrar pelo vocabulário do utilizador. */
  aliases?: string[];
  /** Marca o item que recebe o contador de inspeções. */
  badge?: "inspection";
}

interface NavSubgroupDef {
  /** Cabeçalho de subgrupo (null = sem cabeçalho). Só Imóvel usa. */
  label: string | null;
  items: NavItemDef[];
}

/** Entrada de topo: link direto (Painel, Cobranças) ou grupo com dropdown. */
type NavEntryDef =
  | { kind: "link"; label: string; section: string; path: string; aliases?: string[] }
  | { kind: "group"; label: string; badge?: "inspection"; subgroups: NavSubgroupDef[] };

const NAV: NavEntryDef[] = [
  {
    kind: "link",
    label: "Painel",
    section: "dashboard",
    path: "/dashboard",
    aliases: ["dashboard", "inicio", "resumo"],
  },
  {
    kind: "link",
    label: "Cobranças",
    section: "charges_receivable",
    path: "/charges?kind=receivable",
    aliases: ["quota", "quotas", "receitas", "a receber", "condomino paga"],
  },
  {
    kind: "group",
    label: "Despesas",
    subgroups: [{
      label: null,
      items: [
        {
          label: "A pagar",
          section: "charges_payable",
          path: "/charges?kind=payable",
          aliases: ["despesa", "fatura", "contas a pagar", "pagamento"],
        },
        {
          label: "Recorrentes",
          section: "recurring",
          path: "/recurring",
          aliases: ["recorrente", "periodica", "mensal", "debito"],
        },
        {
          label: "Fornecedores",
          section: "suppliers",
          path: "/suppliers",
          aliases: ["fornecedor", "prestador", "empresa"],
        },
        {
          label: "Plano de contas",
          section: "expense-categories",
          path: "/expense-categories",
          aliases: ["categorias", "rubricas", "conta", "contas"],
        },
      ],
    }],
  },
  {
    kind: "group",
    label: "Banco",
    subgroups: [{
      label: null,
      items: [
        {
          label: "Contas",
          section: "bank_accounts",
          path: "/bank-accounts",
          aliases: ["conta bancaria", "iban", "saldo"],
        },
        {
          label: "Conciliação",
          section: "reconciliation",
          path: "/reconciliation",
          aliases: ["conciliar", "reconciliacao", "extrato", "movimentos", "settlement"],
        },
        {
          label: "Recibos",
          section: "receipts",
          path: "/receipts",
          aliases: ["recibo", "comprovativo", "quitacao"],
        },
      ],
    }],
  },
  {
    kind: "group",
    label: "Imóvel",
    badge: "inspection",
    subgroups: [
      {
        label: "Pessoas e frações",
        items: [
          {
            label: "Frações",
            section: "units",
            path: "/units",
            aliases: ["fracao", "fracoes", "apartamento", "unidade", "lote"],
          },
          {
            label: "Ocupantes",
            section: "occupants",
            path: "/occupants",
            aliases: ["condomino", "proprietario", "inquilino", "morador", "residente"],
          },
          {
            label: "Seguros",
            section: "insurance",
            path: "/insurances",
            aliases: ["seguro", "apolice", "poliza"],
          },
        ],
      },
      {
        label: "Manutenção",
        items: [
          {
            label: "Inspeções",
            section: "inspection",
            path: "/inspections",
            aliases: ["inspecao", "vistoria", "manutencao", "elevador", "extintor"],
            badge: "inspection",
          },
          {
            label: "Ocorrências",
            section: "tickets",
            path: "/tickets",
            aliases: ["ocorrencia", "ticket", "chamado", "avaria", "reclamacao"],
          },
          {
            label: "Patologias",
            section: "pathology",
            path: "/pathologies",
            aliases: ["patologia", "anomalia", "defeito", "infiltracao", "fissura"],
          },
          {
            label: "Documentos",
            section: "documents",
            path: "/documents",
            aliases: ["documento", "regulamento", "ata", "contrato", "anexo", "pdf"],
          },
        ],
      },
    ],
  },
  {
    kind: "group",
    label: "Governance",
    subgroups: [{
      label: null,
      items: [
        {
          label: "Orçamento",
          section: "budget",
          path: "/budget",
          aliases: ["orcamento", "budget", "previsao"],
        },
        {
          label: "Assembleias",
          section: "assembly",
          path: "/assembly",
          aliases: ["assembleia", "reuniao", "deliberacao", "ordem do dia", "convocatoria", "ag"],
        },
      ],
    }],
  },
  {
    kind: "group",
    label: "Relatórios",
    subgroups: [{
      label: null,
      items: [
        {
          label: "Movimentos do ano",
          section: "report_movements",
          path: "/reports/movements",
          aliases: ["extrato", "movimento", "movimentacao", "bolsa", "fcr", "ordinaria", "caixa"],
        },
        {
          label: "Previsão de tesouraria",
          section: "report_cashflow",
          path: "/reports/cashflow",
          aliases: ["tesouraria", "cashflow", "previsao", "fluxo de caixa", "entradas", "saidas"],
        },
        {
          label: "Execução por Ata",
          section: "report_assemblies",
          path: "/reports/assemblies",
          aliases: ["ata", "assembleia", "execucao", "orcamento vs real", "obra", "quotas"],
        },
      ],
    }],
  },
  {
    kind: "group",
    label: "Sistema",
    subgroups: [{
      label: null,
      items: [
        {
          label: "Utilizadores",
          section: "users",
          path: "/users",
          aliases: ["utilizador", "user", "gestor", "administrador", "acesso"],
        },
        {
          label: "Condomínios",
          section: "condominiums",
          path: "/condominiums",
          aliases: ["condominio", "predio", "edificio"],
        },
      ],
    }],
  },
];

// ─── Modelo por-request (o que os templates consomem) ──────────────────────

export interface NavLinkModel {
  label: string;
  href: string;
  active: boolean;
  /** Contador a mostrar como badge (0 = sem badge). */
  badgeCount: number;
}

export interface NavSubgroupModel {
  label: string | null;
  items: NavLinkModel[];
}

export type NavEntryModel =
  | { kind: "link"; label: string; href: string; active: boolean }
  | {
    kind: "group";
    label: string;
    active: boolean;
    hasBadge: boolean;
    subgroups: NavSubgroupModel[];
  };

/** Item plano para o palette (serializado em JSON no template). */
export interface PaletteItem {
  label: string;
  href: string;
  /** Caminho legível ("Imóvel → Manutenção"); "" para links de topo. */
  path: string;
  /** Grupo de topo, para agrupar a lista com query vazia. */
  group: string;
  /** Sinónimos juntos, para o haystack de pesquisa. */
  terms: string;
}

export interface AdminNav {
  entries: NavEntryModel[];
  palette: PaletteItem[];
}

interface BuildOpts {
  cid: string | null;
  activeSection: string | null;
  inspectionAlertCount: number;
  availableCondominiums: Array<{ id: string; name: string }>;
  occupantUnits: Array<{ condominiumId: string; unitId: string }>;
}

export function buildAdminNav(opts: BuildOpts): AdminNav | null {
  if (!opts.cid) return null;
  const base = `/admin/c/${opts.cid}`;
  const badgeFor = (b?: "inspection") => (b === "inspection" ? opts.inspectionAlertCount : 0);

  const entries: NavEntryModel[] = [];
  const palette: PaletteItem[] = [];

  for (const e of NAV) {
    if (e.kind === "link") {
      entries.push({
        kind: "link",
        label: e.label,
        href: base + e.path,
        active: e.section === opts.activeSection,
      });
      palette.push({
        label: e.label,
        href: base + e.path,
        path: "",
        group: "Geral",
        terms: (e.aliases ?? []).join(" "),
      });
      continue;
    }

    const subgroups: NavSubgroupModel[] = e.subgroups.map((sg) => ({
      label: sg.label,
      items: sg.items.map((it) => ({
        label: it.label,
        href: base + it.path,
        active: it.section === opts.activeSection,
        badgeCount: badgeFor(it.badge),
      })),
    }));

    const allItems = subgroups.flatMap((sg) => sg.items);
    entries.push({
      kind: "group",
      label: e.label,
      active: allItems.some((it) => it.active),
      hasBadge: allItems.some((it) => it.badgeCount > 0),
      subgroups,
    });

    for (const sg of e.subgroups) {
      const path = sg.label ? `${e.label} → ${sg.label}` : e.label;
      for (const it of sg.items) {
        palette.push({
          label: it.label,
          href: base + it.path,
          path,
          group: e.label,
          terms: (it.aliases ?? []).join(" "),
        });
      }
    }
  }

  // Atalho ao portal (só se o user também for ocupante).
  const ou = opts.occupantUnits[0];
  if (ou) {
    palette.push({
      label: "Portal da minha fração",
      href: `/portal/c/${ou.condominiumId}/u/${ou.unitId}`,
      path: "Atalho",
      group: "Atalhos",
      terms: "portal fracao minha condomino",
    });
  }

  // Trocar de condomínio: única exceção à regra "só navegação". O dado já
  // está em memória (availableCondominiums), por isso não custa endpoint nem
  // query nova.
  if (opts.availableCondominiums.length > 1) {
    for (const c of opts.availableCondominiums) {
      if (c.id === opts.cid) continue;
      palette.push({
        label: c.name,
        href: `/admin/c/${c.id}/dashboard`,
        path: "Trocar de condomínio",
        group: "Trocar de condomínio",
        terms: "condominio trocar mudar",
      });
    }
  }

  return { entries, palette };
}
