// Parser do XLSX de frações + ocupantes (formato do template gerado).
// Devolve arrays normalizados para preview/commit com deduplicação.

import * as XLSX from "xlsx";
import { RELATIONSHIP_TYPES, UNIT_TYPES } from "$api/libs/enums.ts";

export interface ParsedUnitRow {
  designation: string;
  unitType: string;
  permillage: number | null;
  block: string | null;
  floor: string | null;
  door: string | null;
  description: string | null;
}

export interface ParsedOccupantRow {
  name: string;
  email: string | null;
  phone: string | null;
  nif: string | null;
}

export interface ParsedLinkRow {
  unitDesignation: string;
  // Chave do ocupante: email > nif > nome (para linkar depois do dedup).
  occupantKey: string;
  relationshipType: string;
}

export interface ParseResult {
  units: ParsedUnitRow[]; // deduplicadas por designation
  occupants: ParsedOccupantRow[]; // deduplicadas por email/nif
  links: ParsedLinkRow[];
  warnings: string[];
}

const VALID_TYPES: Set<string> = new Set(UNIT_TYPES);
const VALID_RELATIONS: Set<string> = new Set(RELATIONSHIP_TYPES);

function s(v: unknown): string {
  return typeof v === "string" ? v.trim() : v != null ? String(v).trim() : "";
}

function occupantKey(name: string, email: string | null, nif: string | null): string {
  if (email) return `e:${email.toLowerCase()}`;
  if (nif) return `n:${nif}`;
  return `name:${name.toLowerCase()}`;
}

// CSV em UTF-8 sem BOM: o xlsx lê os bytes como Latin-1 e estraga os acentos.
// Texto que não é UTF-8 válido (ex: Windows-1252) segue pela leitura binária.
function readWorkbook(bytes: Uint8Array): XLSX.WorkBook {
  const isZipOrOle = (bytes[0] === 0x50 && bytes[1] === 0x4B) ||
    (bytes[0] === 0xD0 && bytes[1] === 0xCF);
  const text = isZipOrOle ? null : decodeUtf8(bytes);
  return text != null ? XLSX.read(text, { type: "string" }) : XLSX.read(bytes, { type: "array" });
}

function decodeUtf8(bytes: Uint8Array): string | null {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
}

export function parseUnitsImport(bytes: Uint8Array): ParseResult {
  const wb = readWorkbook(bytes);
  const sheet = wb.Sheets["Dados"] ?? wb.Sheets[wb.SheetNames[0]];
  if (!sheet) return { units: [], occupants: [], links: [], warnings: ["Folha vazia"] };

  const raw = XLSX.utils.sheet_to_json<unknown[]>(sheet, { header: 1, defval: null });
  const warnings: string[] = [];

  // Salta linha de header (deteta "Fração" na A1).
  // Cobre AO90 ("fração" → "fraç") e pré-AO ("fração" → "frac"). O
  // `startsWith("frac")` puro não bastava: "fração" tem "ç" no 4º char.
  let start = 0;
  const a1 = s(raw[0]?.[0]).toLowerCase();
  if (a1.startsWith("fraç") || a1.startsWith("frac")) start = 1;

  const units = new Map<string, ParsedUnitRow>();
  const occupants = new Map<string, ParsedOccupantRow>();
  const links: ParsedLinkRow[] = [];

  for (let i = start; i < raw.length; i++) {
    const r = raw[i];
    if (!r || r.length === 0) continue;
    const designation = s(r[0]);
    if (!designation) {
      // Linha sem fração → ignora silenciosamente (vazias no fim do ficheiro).
      continue;
    }

    let unitType = s(r[1]).toLowerCase() || "residential";
    if (!VALID_TYPES.has(unitType)) {
      warnings.push(`Linha ${i + 1}: tipo "${unitType}" inválido, usei 'residential'`);
      unitType = "residential";
    }

    const permRaw = r[2];
    const permillage = typeof permRaw === "number"
      ? permRaw
      : permRaw != null && !isNaN(parseFloat(String(permRaw).replace(",", ".")))
      ? parseFloat(String(permRaw).replace(",", "."))
      : null;

    const unit: ParsedUnitRow = {
      designation,
      unitType,
      permillage,
      block: s(r[3]) || null,
      floor: s(r[4]) || null,
      door: s(r[5]) || null,
      description: s(r[6]) || null,
    };

    // Dedup por designation. Se já existe, mantém a primeira (mas avisa se valores divergem).
    const existing = units.get(designation);
    if (!existing) {
      units.set(designation, unit);
    } else {
      if (
        existing.permillage != null && unit.permillage != null &&
        existing.permillage !== unit.permillage
      ) {
        warnings.push(
          `Linha ${
            i + 1
          }: fração ${designation} já aparece com permilagem diferente (${existing.permillage} vs ${unit.permillage}); mantive ${existing.permillage}`,
        );
      }
    }

    // Ocupante (opcional) - agora em H-L (índices 7-11).
    const name = s(r[7]);
    if (!name) continue; // linha só-fração (sem ocupante)

    const email = s(r[8]).toLowerCase() || null;
    const phone = s(r[9]) || null;
    const nif = s(r[10]) || null;
    let rel = s(r[11]).toLowerCase() || "owner";
    if (!VALID_RELATIONS.has(rel)) {
      warnings.push(`Linha ${i + 1}: relação "${rel}" inválida, usei 'owner'`);
      rel = "owner";
    }

    const key = occupantKey(name, email, nif);
    if (!occupants.has(key)) {
      occupants.set(key, { name, email, phone, nif });
    }
    links.push({ unitDesignation: designation, occupantKey: key, relationshipType: rel });
  }

  // Fusão por nome: se a mesma pessoa aparece numa linha sem contactos
  // (`name:`) e noutra com email/nif, funde no registo "rico" (canónico) e
  // redireciona os links. Dois "ricos" com o mesmo nome (NIFs diferentes) NÃO
  // se fundem (pessoas distintas).
  const keysByName = new Map<string, string[]>();
  for (const [key, o] of occupants.entries()) {
    const nameLower = o.name.toLowerCase();
    const arr = keysByName.get(nameLower) ?? [];
    arr.push(key);
    keysByName.set(nameLower, arr);
  }
  const keyRedirect = new Map<string, string>();
  for (const [, keys] of keysByName.entries()) {
    if (keys.length < 2) continue;
    const hasPoor = keys.some((k) => k.startsWith("name:"));
    if (!hasPoor) continue; // todos identificados - pessoas distintas
    const canonical = keys.find((k) => !k.startsWith("name:")) ?? keys[0];
    for (const k of keys) {
      if (k !== canonical && k.startsWith("name:")) keyRedirect.set(k, canonical);
    }
  }
  if (keyRedirect.size > 0) {
    for (const oldKey of keyRedirect.keys()) occupants.delete(oldKey);
    for (const l of links) {
      const newKey = keyRedirect.get(l.occupantKey);
      if (newKey) l.occupantKey = newKey;
    }
    warnings.push(
      `${keyRedirect.size} ocupante(s) sem contactos foram fundidos com outro registo do mesmo nome (reutilizado o registo com email/NIF).`,
    );
  }

  return {
    units: [...units.values()],
    occupants: [...occupants.values()].map((o, _idx) => o),
    links,
    warnings,
  };
}
