// Labels PT-PT dos enums de ticket. Partilhados pelo auto-comment de transição
// (handlers.ts) e pelos emails de notificação (_notify.ts).

export const TICKET_STATUS_LABELS: Record<string, string> = {
  open: "Aberto",
  in_progress: "Em progresso",
  resolved: "Resolvido",
  closed: "Fechado",
};

export const TICKET_CATEGORY_LABELS: Record<string, string> = {
  elevator: "Elevador",
  lighting: "Iluminação",
  plumbing: "Canalizações / Infiltrações",
  hvac: "AVAC / Ventilação",
  common_area: "Áreas comuns",
  facade: "Fachada / Exterior",
  parking: "Estacionamento",
  garden: "Jardim / Espaços verdes",
  security: "Segurança",
  cleaning: "Limpeza",
  other: "Outros",
};

export const TICKET_PRIORITY_LABELS: Record<string, string> = {
  low: "Baixa",
  normal: "Normal",
  high: "Alta",
  urgent: "Urgente",
};
