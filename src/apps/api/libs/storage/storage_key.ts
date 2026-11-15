// Constrói storage keys "sharded" (2 primeiros chars do id pai) para evitar
// milhares de dirs no mesmo nível. Padrão (2026-05):
//   <cid>/<entity>/<shard>/<parent_id>/<attachment_id>-<filename>
// cid no topo para backup/restore por condomínio (`s3 cp s3://bucket/<cid>/`).
// Keys antigos coexistem (storage_key na BD é absoluto).

// Shard dos 2 primeiros chars do id pai (chars fora de [a-zA-Z0-9_-] viram `_`).
// SEMPRE minúsculas: num FS case-insensitive (APFS/NTFS) durante backup/restore,
// `J/` e `j/` colapsam e desalinham o storage_key. Custo: 36 buckets vs 62.
export function shardOf(parentId: string): string {
  const safe = (parentId ?? "").replace(/[^a-zA-Z0-9_-]/g, "_");
  const a = (safe[0] ?? "_").toLowerCase();
  const b = (safe[1] ?? "_").toLowerCase();
  return `${a}/${b}`;
}

// Storage key completo: <cid>/<entity>/<shard>/<parentId>/<attachmentId>-<safeName>.
// O `filename` já vem sanitizado pelo caller.
export function buildStorageKey(args: {
  entity: string; // "tickets" | "charges" | "inspections" | "assemblies"
  condominiumId: string;
  parentId: string;
  attachmentId: string;
  filename: string; // já sanitizado pelo caller
}): string {
  const shard = shardOf(args.parentId);
  return `${args.condominiumId}/${args.entity}/${shard}/${args.parentId}/${args.attachmentId}-${args.filename}`;
}

// Variante para entidades com 1 ficheiro único (receipts, insurance - o ficheiro
// É a entidade): <cid>/<entity>/<shard>/<entityId>/<filename>.
export function buildEntityStorageKey(args: {
  entity: string; // "receipts" | "insurance"
  condominiumId: string;
  entityId: string;
  filename: string;
}): string {
  const shard = shardOf(args.entityId);
  return `${args.condominiumId}/${args.entity}/${shard}/${args.entityId}/${args.filename}`;
}
