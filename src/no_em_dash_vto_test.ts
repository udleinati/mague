// Guard global: nenhum template .vto pode conter em-dash (U+2014). Texto
// visível e atributos vão para o HTML/PDF entregue ao utilizador (regra global
// do CLAUDE.md). Os guards per-template (assembly_*_render_test,
// email/templates_test) só cobrem alguns templates; este apanha qualquer .vto.

import { assert } from "@std/assert";
import { fromFileUrl, join, relative } from "@std/path";

const EM_DASH = String.fromCharCode(0x2014);

Deno.test("nenhum template .vto contém em-dash (U+2014)", async () => {
  const root = fromFileUrl(new URL("./", import.meta.url));
  const vtos: string[] = [];
  async function walk(dir: string) {
    for await (const entry of Deno.readDir(dir)) {
      const full = join(dir, entry.name);
      if (entry.isDirectory) await walk(full);
      else if (entry.name.endsWith(".vto")) vtos.push(full);
    }
  }
  await walk(root);

  if (vtos.length < 100) {
    throw new Error(`só ${vtos.length} .vto encontrados - glob partido?`);
  }

  const offenders: string[] = [];
  for (const path of vtos) {
    const lines = (await Deno.readTextFile(path)).split("\n");
    lines.forEach((line, i) => {
      if (line.includes(EM_DASH)) offenders.push(`${relative(root, path)}:${i + 1}`);
    });
  }

  assert(
    offenders.length === 0,
    `em-dash (U+2014) proibido; usar hífen "-". Ocorrências:\n${offenders.join("\n")}`,
  );
});
