// GET /v1/admin/c/:cid/units/import/template.xlsx
// Devolve template xlsx pronto a preencher (frações + ocupantes).

import type { Context } from "hono";
import { generateUnitsImportTemplate } from "$api/libs/unit_import/template.ts";

export const importTemplate = (_ctx: Context): Response => {
  const bytes = generateUnitsImportTemplate();
  // Cópia para ArrayBuffer puro (Response não aceita Uint8Array genérico).
  const ab = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(ab).set(bytes);
  return new Response(ab, {
    status: 200,
    headers: {
      "content-type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "content-disposition": 'attachment; filename="import_fracoes_ocupantes.xlsx"',
      "cache-control": "no-store",
    },
  });
};
