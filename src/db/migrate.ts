import { fromFileUrl, join } from "@std/path";
import { closePool, transaction } from "./client.ts";

const MIGRATIONS_DIR = fromFileUrl(new URL("./migrations/", import.meta.url));
const COMPONENTS_DIR = fromFileUrl(new URL("./components/", import.meta.url));

interface Migration {
  filename: string;
  sql: string;
}

async function ensureMigrationsTable(): Promise<void> {
  await transaction(async (tx) => {
    await tx.queryObject(`
      CREATE TABLE IF NOT EXISTS _migrations (
        filename TEXT PRIMARY KEY,
        applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
  });
}

async function getAppliedMigrations(): Promise<Set<string>> {
  const applied = new Set<string>();
  await transaction(async (tx) => {
    const result = await tx.queryObject<{ filename: string }>(
      "SELECT filename FROM _migrations ORDER BY filename",
    );
    for (const row of result.rows) applied.add(row.filename);
  });
  return applied;
}

async function loadMigrations(): Promise<Migration[]> {
  const migrations: Migration[] = [];
  try {
    for await (const entry of Deno.readDir(MIGRATIONS_DIR)) {
      if (!entry.isFile || !entry.name.endsWith(".sql")) continue;
      const sql = await Deno.readTextFile(join(MIGRATIONS_DIR, entry.name));
      migrations.push({ filename: entry.name, sql });
    }
  } catch (err) {
    if (err instanceof Deno.errors.NotFound) {
      console.log("Pasta de migrações não existe ainda - nada a aplicar.");
      return [];
    }
    throw err;
  }
  // Ordem alfabética garante a sequência (001_, 002_, ...)
  migrations.sort((a, b) => a.filename.localeCompare(b.filename));
  return migrations;
}

async function applyMigration(migration: Migration): Promise<void> {
  await transaction(async (tx) => {
    await tx.queryObject(migration.sql);
    await tx.queryObject(
      "INSERT INTO _migrations (filename) VALUES ($1)",
      [migration.filename],
    );
  });
}

// ─── Components (CREATE OR REPLACE - sempre executados) ───────────────────────

async function loadComponents(): Promise<Migration[]> {
  const components: Migration[] = [];
  try {
    for await (const entry of Deno.readDir(COMPONENTS_DIR)) {
      if (!entry.isFile || !entry.name.endsWith(".sql")) continue;
      const sql = await Deno.readTextFile(join(COMPONENTS_DIR, entry.name));
      components.push({ filename: entry.name, sql });
    }
  } catch (err) {
    if (err instanceof Deno.errors.NotFound) return [];
    throw err;
  }
  components.sort((a, b) => a.filename.localeCompare(b.filename));
  return components;
}

async function applyComponent(component: Migration): Promise<void> {
  // Sem transação de controlo - cada ficheiro é auto-suficiente e idempotente.
  await transaction(async (tx) => {
    await tx.queryObject(component.sql);
  });
}

// Pré-requisitos: apenas funções puras (sem dependência de tabelas)
// Ficheiros 000_* e 001_* - nanoid, helpers
async function applyPrerequisiteComponents(): Promise<void> {
  const all = await loadComponents();
  const prereqs = all.filter((c) => c.filename < "002");
  if (prereqs.length === 0) return;
  console.log(`\nA aplicar ${prereqs.length} pré-requisito(s)...`);
  for (const c of prereqs) {
    console.log(`  ↺ ${c.filename}`);
    await applyComponent(c);
  }
  console.log("Pré-requisitos aplicados.");
}

async function applyComponents(): Promise<void> {
  const components = await loadComponents();
  if (components.length === 0) return;
  console.log(`\nA aplicar ${components.length} component(s) (CREATE OR REPLACE)...`);
  for (const c of components) {
    console.log(`  ↺ ${c.filename}`);
    try {
      await applyComponent(c);
    } catch (err) {
      console.error(`  ✗ Falhou: ${c.filename}`);
      throw err;
    }
  }
  console.log("Components aplicados com sucesso.");
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  console.log("A executar migrações...");

  // Componentes 000_*/001_* (ex: nanoid()) são precisos nos DEFAULTs das tabelas.
  await applyPrerequisiteComponents();

  await ensureMigrationsTable();
  const applied = await getAppliedMigrations();
  const migrations = await loadMigrations();

  const pending = migrations.filter((m) => !applied.has(m.filename));
  if (pending.length === 0) {
    console.log("Nenhuma migração pendente.");
  } else {
    console.log(`${pending.length} migração(ões) pendente(s).`);
    for (const migration of pending) {
      // Se o bootstrap é pendente mas já existem migrações antigas aplicadas,
      // o schema já existe - apenas registar sem executar.
      if (migration.filename === "001_bootstrap.sql" && applied.size > 0) {
        console.log(`  → ${migration.filename} (schema já existe - a registar)`);
        await transaction(async (tx) => {
          await tx.queryObject(
            "INSERT INTO _migrations (filename) VALUES ($1)",
            [migration.filename],
          );
        });
        continue;
      }
      console.log(`  → ${migration.filename}`);
      try {
        await applyMigration(migration);
      } catch (err) {
        console.error(`  ✗ Falhou: ${migration.filename}`);
        throw err;
      }
    }
    console.log("Migrações aplicadas com sucesso.");
  }

  // Components re-aplicados DEPOIS das migrações (caso novas migrações alterem schemas)
  await applyComponents();
}

if (import.meta.main) {
  try {
    await main();
  } catch (err) {
    console.error("Erro durante migração:", err);
    Deno.exit(1);
  } finally {
    await closePool();
  }
}
