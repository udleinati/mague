// Executa os SQL de src/db/seeds/ por ordem alfabética. Uso: `deno task seed`.

import "@std/dotenv/load";
import { fromFileUrl, join } from "@std/path";
import { closePool, transaction } from "./client.ts";

async function main() {
  // --dir=<pasta>  →  pasta dentro de src/db/ a usar (default: seeds).
  // Exemplo: --dir=seeds_minimal
  const dirArg = Deno.args.find((a) => a.startsWith("--dir="));
  const dirName = dirArg ? dirArg.slice("--dir=".length) : "seeds";
  const SEEDS_DIR = fromFileUrl(new URL(`./${dirName}/`, import.meta.url));

  const entries: Array<{ name: string; sql: string }> = [];

  for await (const entry of Deno.readDir(SEEDS_DIR)) {
    if (!entry.isFile || !entry.name.endsWith(".sql")) continue;
    const sql = await Deno.readTextFile(join(SEEDS_DIR, entry.name));
    entries.push({ name: entry.name, sql });
  }

  entries.sort((a, b) => a.name.localeCompare(b.name));

  console.log(
    `[seed] ${entries.length} ficheiro(s) encontrado(s) em ${dirName}/`,
  );

  for (const entry of entries) {
    console.log(`[seed] a executar ${entry.name} ...`);
    await transaction(async (tx) => {
      await tx.queryObject(entry.sql);
    });
  }

  console.log("[seed] done.");
}

main()
  .catch((err) => {
    console.error("[seed] ERRO:", err);
    Deno.exit(1);
  })
  .finally(closePool);
