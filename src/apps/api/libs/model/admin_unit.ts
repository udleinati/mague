import { z } from "zod";

// Os limites correspondem às VARCHAR(n) da tabela `core.unit` - valores
// acima rebentavam em 500 DB_ERROR em vez de 422 de validação.
export const unitUpdateDescriptionSchema = z.object({
  description: z.string().max(500).nullable().optional(),
  designation: z.string().min(1).max(50).optional(),
  floor: z.string().max(20).nullable().optional(),
  door: z.string().max(20).nullable().optional(),
  block: z.string().max(50).nullable().optional(),
  // Lista de palavras-chave para sugestão automática na conciliação.
  // Trim + dedup são feitos no handler antes de persistir.
  matchKeywords: z.array(z.string().min(1).max(100)).max(30).optional(),
});
