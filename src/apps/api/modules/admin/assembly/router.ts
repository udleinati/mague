import { Hono } from "hono";
import type { ApiEnv } from "$api/middleware/api_auth.ts";
import { postgres } from "$api/libs/postgres/postgres.ts";
import { listAssemblies } from "./list.ts";
import { getAssembly } from "./retrieve.ts";
import { createAssembly } from "./create.ts";
import { updateAssembly } from "./update.ts";
import { deleteAssembly } from "./delete.ts";
import { createAssemblyAgendaItem } from "./create_agenda_item.ts";
import { updateAssemblyAgendaItem } from "./update_agenda_item.ts";
import { deleteAssemblyAgendaItem } from "./delete_agenda_item.ts";
import {
  deleteAssemblyAttachmentHandler,
  listAssemblyAttachmentsHandler,
  serveAssemblyAttachmentHandler,
  uploadAssemblyAttachmentHandler,
} from "./attachments.ts";
import { createAttendee, deleteAttendee, listAttendees, updateAttendee } from "./attendees.ts";
import { getAssemblyMinutesPdf } from "./minutes_pdf.ts";
import { getAssemblyConvocationPdf, getAssemblyProxyPdf } from "./convocation_pdf.ts";
import { getAssemblyAttendanceSheetPdf } from "./attendance_sheet_pdf.ts";
import { sendAssemblyConvocation, sendAssemblyConvocationIndividual } from "./send_convocation.ts";
import { listAssemblyConvocationRecipients } from "./convocation_recipient_status.ts";
import { previewAssemblyConvocationEmail } from "./convocation_preview.ts";

export const assemblyRoutes = () => {
  const route = new Hono<ApiEnv>();
  const basePath = "/assemblies";

  route.get(basePath, (ctx) => listAssemblies(ctx, postgres));
  route.post(basePath, (ctx) => createAssembly(ctx, postgres));
  route.get(`${basePath}/:assemblyId`, (ctx) => getAssembly(ctx, postgres));
  route.patch(`${basePath}/:assemblyId`, (ctx) => updateAssembly(ctx, postgres));
  route.delete(`${basePath}/:assemblyId`, (ctx) => deleteAssembly(ctx, postgres));

  // PDF on-demand da ata (não arquivado - re-gerado a cada pedido).
  route.get(
    `${basePath}/:assemblyId/minutes.pdf`,
    (ctx) => getAssemblyMinutesPdf(ctx, postgres),
  );

  // Pré-visualização (read-only) dos PDFs da convocatória + procuração. Não mudam estado.
  route.get(
    `${basePath}/:assemblyId/convocation.pdf`,
    (ctx) => getAssemblyConvocationPdf(ctx, postgres),
  );
  route.get(
    `${basePath}/:assemblyId/proxy.pdf`,
    (ctx) => getAssemblyProxyPdf(ctx, postgres),
  );

  // Folha de presenças em branco (1 linha por fração) para imprimir antes da reunião.
  route.get(
    `${basePath}/:assemblyId/attendance-sheet.pdf`,
    (ctx) => getAssemblyAttendanceSheetPdf(ctx, postgres),
  );

  // Destinatários da convocatória + cooldown (read-only); alimenta a tabela "Destinatários".
  route.get(
    `${basePath}/:assemblyId/convocation/recipients`,
    (ctx) => listAssemblyConvocationRecipients(ctx, postgres),
  );

  // Pré-visualização (read-only) do corpo do email da convocatória, por (pessoa, fração).
  route.get(
    `${basePath}/:assemblyId/convocation/preview/:occupantId/:unitId`,
    (ctx) => previewAssemblyConvocationEmail(ctx, postgres),
  );

  // Envio bulk - bloqueado em `draft` (422 CONVOCATION_DRAFT); 1 despacho por fração
  // (ADR 0034), regista run, salta cooldown e reporta a contagem.
  route.post(
    `${basePath}/:assemblyId/convocation/send`,
    (ctx) => sendAssemblyConvocation(ctx, postgres),
  );
  // Reenvio individual - cooldown 24h por (pessoa, fração) (422 COOLDOWN_ACTIVE).
  route.post(
    `${basePath}/:assemblyId/convocation/send/:occupantId/:unitId`,
    (ctx) => sendAssemblyConvocationIndividual(ctx, postgres),
  );

  // Agenda items
  route.post(
    `${basePath}/:assemblyId/agenda-items`,
    (ctx) => createAssemblyAgendaItem(ctx, postgres),
  );
  route.patch(
    `${basePath}/:assemblyId/agenda-items/:agendaItemId`,
    (ctx) => updateAssemblyAgendaItem(ctx, postgres),
  );
  route.delete(
    `${basePath}/:assemblyId/agenda-items/:agendaItemId`,
    (ctx) => deleteAssemblyAgendaItem(ctx, postgres),
  );

  // Attendees (presenças + procurações - Art. 1432.º + 1431.º nº 5)
  route.get(`${basePath}/:assemblyId/attendees`, (ctx) => listAttendees(ctx, postgres));
  route.post(`${basePath}/:assemblyId/attendees`, (ctx) => createAttendee(ctx, postgres));
  route.patch(
    `${basePath}/:assemblyId/attendees/:attendeeId`,
    (ctx) => updateAttendee(ctx, postgres),
  );
  route.delete(
    `${basePath}/:assemblyId/attendees/:attendeeId`,
    (ctx) => deleteAttendee(ctx, postgres),
  );

  // Attachments (ata PDF, presenças, anexos pontuais)
  route.get(
    `${basePath}/:assemblyId/attachments`,
    (ctx) => listAssemblyAttachmentsHandler(ctx, postgres),
  );
  route.post(
    `${basePath}/:assemblyId/attachments`,
    (ctx) => uploadAssemblyAttachmentHandler(ctx, postgres),
  );
  route.get(
    `${basePath}/:assemblyId/attachments/:attachmentId`,
    (ctx) => serveAssemblyAttachmentHandler(ctx, postgres),
  );
  route.delete(
    `${basePath}/:assemblyId/attachments/:attachmentId`,
    (ctx) => deleteAssemblyAttachmentHandler(ctx, postgres),
  );

  return route;
};
