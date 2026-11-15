// Gera template XLSX para import de frações + ocupantes.
//
// Formato: uma folha "Dados" com uma linha por vínculo fração-ocupante.
// Se uma fração tem N ocupantes, o utilizador repete a linha da fração
// e varia só as colunas do ocupante (G-K). Se uma fração ainda não tem
// ocupantes, deixa G-K vazios.
//
// Uma segunda folha "Instruções" documenta cada campo.

import * as XLSX from "xlsx";
import { RELATIONSHIP_TYPES, UNIT_TYPES } from "$api/libs/enums.ts";

const HEADERS = [
  "Fração", // A - obrigatório, ex: A1, A2, G1
  "Tipo", // B - ver UNIT_TYPES em libs/enums.ts
  "Permilagem", // C - número, ex 45.5 (soma total deve dar 1000)
  "Bloco", // D - opcional
  "Piso", // E - opcional
  "Porta", // F - opcional
  "Descrição", // G - opcional, nota livre sobre a fração
  "Nome ocupante", // H - vazio se fração sem ocupantes
  "Email", // I - opcional
  "Telefone", // J - opcional
  "NIF", // K - opcional
  "Relação", // L - owner | tenant (default owner)
];

const EXAMPLE_ROWS: Array<Array<string | number | null>> = [
  [
    "A1",
    "residential",
    45.5,
    "A",
    "1",
    "D",
    "T2 a sul, com varanda",
    "João Silva",
    "joao@exemplo.pt",
    "910000000",
    "500123456",
    "owner",
  ],
  [
    "A1",
    "residential",
    45.5,
    "A",
    "1",
    "D",
    "T2 a sul, com varanda",
    "Maria Silva",
    "maria@exemplo.pt",
    "910000001",
    "500123457",
    "tenant",
  ],
  [
    "A2",
    "residential",
    52.3,
    "A",
    "1",
    "E",
    "T3 de gaveto",
    "António Costa",
    "antonio@exemplo.pt",
    "",
    "500123458",
    "owner",
  ],
  ["Loja1", "commercial", 12.0, "A", "0", "1", "Loja de rua", "", "", "", "", ""],
];

const INSTRUCTIONS = [
  ["Como preencher este ficheiro"],
  [""],
  ["1. Cada linha da folha 'Dados' representa UM vínculo: fração ↔ ocupante."],
  ["2. Se uma fração tem VÁRIOS ocupantes, repete as colunas A-G em várias linhas e muda só H-L."],
  ["3. Se uma fração ainda NÃO tem ocupantes, deixa H-L vazios - a fração é criada mesmo assim."],
  ["4. Deduplicação:"],
  ["   - Fração: pela designação (coluna A) dentro do condomínio."],
  ["   - Ocupante: pelo email (coluna H) ou NIF (coluna J) - se existir, reutiliza; se novo, cria."],
  [""],
  ["Colunas:"],
  ["  A · Fração       - obrigatório (ex: A1, G2, B3)"],
  [`  B · Tipo          - um de: ${UNIT_TYPES.join(", ")} (default: ${UNIT_TYPES[0]})`],
  ["  C · Permilagem    - número decimal (ex 45.5). A soma de todas as frações deve dar 1000."],
  ["  D · Bloco         - opcional"],
  ["  E · Piso          - opcional (texto; use '-1' para subsolo)"],
  ["  F · Porta         - opcional"],
  ["  G · Descrição     - opcional, nota livre (ex: 'T2 a sul, com varanda')"],
  ["  H · Nome ocupante - deixa vazio se a fração não tem ocupante"],
  ["  I · Email         - opcional, usado para deduplicação"],
  ["  J · Telefone      - opcional"],
  ["  K · NIF           - opcional, usado para deduplicação"],
  [`  L · Relação       - um de: ${RELATIONSHIP_TYPES.join(", ")} (default: ${
    RELATIONSHIP_TYPES[0]
  }). owner = proprietário · tenant = inquilino`],
  [""],
  ["Validações no momento do upload:"],
  ["  - Fração sem designação → linha ignorada"],
  ["  - Soma das permilagens não é obrigatoriamente 1000 (podes importar em passos)"],
  ["  - Ocupante com email/NIF já existente → é associado à fração, não duplica"],
];

export function generateUnitsImportTemplate(): Uint8Array {
  const dataSheet = XLSX.utils.aoa_to_sheet([HEADERS, ...EXAMPLE_ROWS]);

  // Larguras de coluna aproximadas para leitura fácil.
  dataSheet["!cols"] = [
    { wch: 10 },
    { wch: 12 },
    { wch: 12 },
    { wch: 8 },
    { wch: 6 },
    { wch: 8 },
    { wch: 30 },
    { wch: 28 },
    { wch: 26 },
    { wch: 14 },
    { wch: 14 },
    { wch: 10 },
  ];

  const instSheet = XLSX.utils.aoa_to_sheet(INSTRUCTIONS);
  instSheet["!cols"] = [{ wch: 100 }];

  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, dataSheet, "Dados");
  XLSX.utils.book_append_sheet(wb, instSheet, "Instruções");

  const out = XLSX.write(wb, { type: "array", bookType: "xlsx" });
  return new Uint8Array(out);
}
