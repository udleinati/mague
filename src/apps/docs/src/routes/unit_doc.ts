import { createRoute, RouteConfig, z } from "@hono/zod-openapi";
import {
  CreateUnitBodyDoc,
  ErrorResponseDoc,
  UnitListResponseDoc,
  UnitParamsDoc,
  UnitResponseWrapperDoc,
  UpdateUnitBodyDoc,
} from "$apps/docs/src/types/unit/unit_response_doc.ts";

export const listUnitsDoc: RouteConfig = {
  description: "Lista todas as frações de um condomínio",
  method: "get",
  path: "/super/condominiums/{id}/units",
  request: {
    params: UnitParamsDoc,
  },
  responses: {
    200: {
      content: {
        "application/json": {
          schema: UnitListResponseDoc,
        },
      },
      description: "Lista de frações",
    },
  },
};

export const createUnitDoc: RouteConfig = {
  description: "Cria uma nova fração",
  method: "post",
  path: "/super/condominiums/{id}/units",
  request: {
    params: UnitParamsDoc,
    body: {
      content: {
        "application/json": {
          schema: CreateUnitBodyDoc,
        },
      },
    },
  },
  responses: {
    201: {
      content: {
        "application/json": {
          schema: UnitResponseWrapperDoc,
        },
      },
      description: "Fração criada",
    },
    400: {
      content: {
        "application/json": {
          schema: ErrorResponseDoc,
        },
      },
      description: "Erro de validação",
    },
  },
};

export const getUnitDoc: RouteConfig = {
  description: "Obtém uma fração pelo ID",
  method: "get",
  path: "/super/condominiums/{id}/units/{unitId}",
  request: {
    params: UnitParamsDoc,
  },
  responses: {
    200: {
      content: {
        "application/json": {
          schema: UnitResponseWrapperDoc,
        },
      },
      description: "Fração encontrada",
    },
    404: {
      content: {
        "application/json": {
          schema: ErrorResponseDoc,
        },
      },
      description: "Fração não encontrada",
    },
  },
};

export const updateUnitDoc: RouteConfig = {
  description: "Atualiza uma fração",
  method: "patch",
  path: "/super/condominiums/{id}/units/{unitId}",
  request: {
    params: UnitParamsDoc,
    body: {
      content: {
        "application/json": {
          schema: UpdateUnitBodyDoc,
        },
      },
    },
  },
  responses: {
    200: {
      content: {
        "application/json": {
          schema: UnitResponseWrapperDoc,
        },
      },
      description: "Fração atualizada",
    },
    404: {
      content: {
        "application/json": {
          schema: ErrorResponseDoc,
        },
      },
      description: "Fração não encontrada",
    },
  },
};

export const deleteUnitDoc: RouteConfig = {
  description: "Remove uma fração (soft delete)",
  method: "delete",
  path: "/super/condominiums/{id}/units/{unitId}",
  request: {
    params: UnitParamsDoc,
  },
  responses: {
    204: {
      description: "Fração removida",
    },
    404: {
      content: {
        "application/json": {
          schema: ErrorResponseDoc,
        },
      },
      description: "Fração não encontrada",
    },
  },
};

// ── Admin-scope (manager, scoped ao condomínio da sessão) ─────────────────

const AdminUnitParamsDoc = z.object({
  cid: z.string().openapi({ example: "MgX001" }),
  unitId: z.string().openapi({ example: "Ky8jDm2LqR", description: "nanoid(10)" }),
});

const AdminCondoParamsDoc = z.object({
  cid: z.string().openapi({ example: "MgX001" }),
});

export const listMeUnitsDoc: RouteConfig = {
  description: "Lista frações do condomínio ativo (admin-scope).",
  method: "get",
  path: "/admin/condominiums/{cid}/units",
  request: { params: AdminCondoParamsDoc },
  responses: {
    200: { content: { "application/json": { schema: UnitListResponseDoc } }, description: "Lista" },
  },
};

export const createMeUnitDoc: RouteConfig = {
  description: "Cria uma fração no condomínio ativo.",
  method: "post",
  path: "/admin/condominiums/{cid}/units",
  request: {
    params: AdminCondoParamsDoc,
    body: { content: { "application/json": { schema: CreateUnitBodyDoc } } },
  },
  responses: {
    201: {
      content: { "application/json": { schema: UnitResponseWrapperDoc } },
      description: "Criada",
    },
    400: {
      content: { "application/json": { schema: ErrorResponseDoc } },
      description: "Validação",
    },
  },
};

export const getMeUnitDoc: RouteConfig = {
  description: "Obtém uma fração pelo ID (admin-scope).",
  method: "get",
  path: "/admin/condominiums/{cid}/units/{unitId}",
  request: { params: AdminUnitParamsDoc },
  responses: {
    200: {
      content: { "application/json": { schema: UnitResponseWrapperDoc } },
      description: "Encontrada",
    },
    404: {
      content: { "application/json": { schema: ErrorResponseDoc } },
      description: "Não encontrada",
    },
  },
};

export const updateMeUnitDoc: RouteConfig = {
  description: "Atualiza descrição / designação / piso / porta / bloco da fração.",
  method: "patch",
  path: "/admin/condominiums/{cid}/units/{unitId}",
  request: {
    params: AdminUnitParamsDoc,
    body: { content: { "application/json": { schema: UpdateUnitBodyDoc } } },
  },
  responses: {
    200: {
      content: { "application/json": { schema: UnitResponseWrapperDoc } },
      description: "Atualizada",
    },
    404: {
      content: { "application/json": { schema: ErrorResponseDoc } },
      description: "Não encontrada",
    },
  },
};

export const deleteMeUnitDoc: RouteConfig = {
  description: "Remove fração (soft delete).",
  method: "delete",
  path: "/admin/condominiums/{cid}/units/{unitId}",
  request: { params: AdminUnitParamsDoc },
  responses: {
    204: { description: "Removida" },
    404: {
      content: { "application/json": { schema: ErrorResponseDoc } },
      description: "Não encontrada",
    },
  },
};

// ── Import XLSX (frações + ocupantes) ─────────────────────────────────────

export const unitsImportTemplateDoc: RouteConfig = {
  description: "Descarrega o template XLSX para preenchimento e posterior import.",
  method: "get",
  path: "/admin/condominiums/{cid}/units/import/template.xlsx",
  request: { params: AdminCondoParamsDoc },
  responses: {
    200: {
      content: {
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": { schema: z.any() },
      },
      description: "Ficheiro XLSX",
    },
  },
};

export const unitsImportPreviewDoc: RouteConfig = {
  description:
    "Pré-visualiza o XLSX preenchido. Parseia frações + ocupantes + relações e identifica duplicados/erros. Não grava.",
  method: "post",
  path: "/admin/condominiums/{cid}/units/import/preview",
  request: {
    params: AdminCondoParamsDoc,
    body: {
      content: {
        "multipart/form-data": {
          schema: z.object({
            file: z.instanceof(File).openapi({ type: "string", format: "binary" }),
          }),
        },
      },
    },
  },
  responses: {
    200: {
      content: {
        "application/json": {
          schema: z.object({
            data: z.object({
              filename: z.string(),
              units: z.array(z.any()),
              occupants: z.array(z.any()),
              links: z.array(z.any()),
              warnings: z.array(z.string()),
              summary: z.record(z.string(), z.unknown()),
            }),
          }),
        },
      },
      description: "Pré-visualização",
    },
    400: {
      content: { "application/json": { schema: ErrorResponseDoc } },
      description: "Ficheiro inválido",
    },
  },
};

export const unitsImportCommitDoc: RouteConfig = {
  description: "Commit do import pós-preview. Cria frações + ocupantes + relações numa transação.",
  method: "post",
  path: "/admin/condominiums/{cid}/units/import/commit",
  request: {
    params: AdminCondoParamsDoc,
    body: {
      content: {
        "application/json": {
          schema: z.object({
            units: z.array(z.any()),
            occupants: z.array(z.any()),
            links: z.array(z.any()),
          }),
        },
      },
    },
  },
  responses: {
    200: {
      content: {
        "application/json": {
          schema: z.object({
            data: z.object({
              unitsCreated: z.number(),
              occupantsCreated: z.number(),
              linksCreated: z.number(),
            }),
          }),
        },
      },
      description: "Import concluído",
    },
    400: {
      content: { "application/json": { schema: ErrorResponseDoc } },
      description: "Payload inválido",
    },
  },
};

const routes = [
  listUnitsDoc,
  createUnitDoc,
  getUnitDoc,
  updateUnitDoc,
  deleteUnitDoc,
  listMeUnitsDoc,
  createMeUnitDoc,
  getMeUnitDoc,
  updateMeUnitDoc,
  deleteMeUnitDoc,
  unitsImportTemplateDoc,
  unitsImportPreviewDoc,
  unitsImportCommitDoc,
].map((route) => createRoute({ ...route, tags: ["Fração"], security: [{ bearerAuth: [] }] }));

export default routes;
