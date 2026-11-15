-- 015_vw_unit_insurance_status.sql
-- Pré-junta unit + TODAS as policies da fração (array JSONB) + indicadores;
-- resolve o N+1 de listUnitsStatus(). A regra "qual policy mostrar?" vive em TS
-- ($shared/insurance/policy_status.ts::selectPolicyForDisplay), não no SQL.
-- Keys JSONB em camelCase (espelham InsurancePolicySelect).

-- DROP+recriar (não CREATE OR REPLACE): a lista de colunas mudou e o PG não
-- permite drop de colunas via REPLACE. DROP IF EXISTS para fresh DBs.
DROP VIEW IF EXISTS core.vw_unit_insurance_status;

CREATE VIEW core.vw_unit_insurance_status AS
SELECT
  u.id              AS unit_id,
  u.condominium_id,
  u.designation,
  u.identifier,
  COALESCE(p.policies, '[]'::jsonb) AS policies,
  r.last_reminder_at,
  r.last_renewal_evidence_at,
  COALESCE(em.has_email, FALSE) AS has_occupant_with_email,
  COALESCE(occs.occupants, '[]'::jsonb) AS occupants
  FROM core.unit u
  LEFT JOIN LATERAL (
    SELECT jsonb_agg(
      jsonb_build_object(
        'id',             ip.id,
        'condominiumId',  ip.condominium_id,
        'unitId',         ip.unit_id,
        -- Ficheiros vivem em core.attachment polimórfica (entity_type='insurance').
        'validFrom',      ip.valid_from,
        'validTo',        ip.valid_to,
        'policyNumber',   ip.policy_number,
        'insurer',        ip.insurer,
        'ocrExtracted',   ip.ocr_extracted,
        'ocrConfidence',  ip.ocr_confidence,
        'status',         ip.status,
        'confirmedBy',    ip.confirmed_by,
        'confirmedAt',    ip.confirmed_at,
        'approvedBy',     ip.approved_by,
        'approvedAt',     ip.approved_at,
        'rejectedBy',     ip.rejected_by,
        'rejectedAt',     ip.rejected_at,
        'rejectedReason', ip.rejected_reason,
        'uploadedBy',     ip.uploaded_by,
        'updatedBy',      ip.updated_by,
        'createdAt',      ip.created_at,
        'updatedAt',      ip.updated_at,
        -- Modelo per-fração (ADRs 0016 + 0017).
        'presumedAt',          ip.presumed_at,
        'evidenceSource',      ip.evidence_source,
        'supersededAt',        ip.superseded_at,
        'coverageAmountCents', ip.coverage_amount_cents,
        'renewedFromId',       ip.renewed_from_id,
        -- Primary attachment: ficheiro mais recente da apólice (NULL se ainda
        -- sem ficheiro). UI decide iframe (PDF) vs img (bitmap) por mime_type.
        'primaryAttachment',   (
          SELECT jsonb_build_object(
            'id',         a.id,
            'mimeType',   a.mime_type,
            'filename',   a.filename
          )
            FROM core.attachment a
           WHERE a.entity_type = 'insurance'
             AND a.entity_id   = ip.id
             AND a.deleted_at IS NULL
        ORDER BY a.created_at DESC
           LIMIT 1
        ),
        'attachmentCount',    (
          SELECT count(*)
            FROM core.attachment a
           WHERE a.entity_type = 'insurance'
             AND a.entity_id   = ip.id
             AND a.deleted_at IS NULL
        ),
        -- Array de attachments (não-deleted), só metadata; bytes via
        -- endpoint /attachments/:attachmentId.
        'attachments', COALESCE((
          SELECT jsonb_agg(
            jsonb_build_object(
              'id',         a.id,
              'mimeType',   a.mime_type,
              'filename',   a.filename
            )
            ORDER BY a.created_at DESC
          )
            FROM core.attachment a
           WHERE a.entity_type = 'insurance'
             AND a.entity_id   = ip.id
             AND a.deleted_at IS NULL
        ), '[]'::jsonb)
      )
      -- Ordem estável só para inspeção; seleção final é em TS.
      ORDER BY ip.created_at DESC
    ) AS policies
      FROM core.insurance_policy ip
     WHERE ip.unit_id = u.id
  ) p ON TRUE
  LEFT JOIN LATERAL (
    -- Duas famílias de trigger, dois cooldowns: "falta seguro" (individual/bulk)
    -- e "falta o comprovativo da renovação" (renewal_evidence). Somados numa só
    -- data, renovar cegava o botão "Lembrar" durante 14 dias.
    SELECT MAX(sent_at) FILTER (WHERE trigger <> 'renewal_evidence') AS last_reminder_at,
           MAX(sent_at) FILTER (WHERE trigger =  'renewal_evidence') AS last_renewal_evidence_at
      FROM core.insurance_reminder
     WHERE unit_id = u.id
  ) r ON TRUE
  LEFT JOIN LATERAL (
    SELECT EXISTS(
      SELECT 1
        FROM core.unit_occupant uo
        JOIN core.occupant o ON o.id = uo.occupant_id
       WHERE uo.unit_id = u.id
         AND uo.deleted_at IS NULL
         AND uo.start_date <= CURRENT_DATE
         AND (uo.end_date IS NULL OR uo.end_date >= CURRENT_DATE)
         AND o.deleted_at IS NULL
         AND o.email IS NOT NULL AND o.email <> ''
    ) AS has_email
  ) em ON TRUE
  LEFT JOIN LATERAL (
    -- Ocupantes ativos. Ordem: owner > tenant > resident, depois nome ASC
    -- (paridade visual com units/list.vto).
    SELECT jsonb_agg(
      jsonb_build_object(
        'name',             o.name,
        'relationshipType', uo.relationship_type
      )
      ORDER BY CASE uo.relationship_type
                 WHEN 'owner' THEN 0
                 WHEN 'tenant' THEN 1
                 WHEN 'resident' THEN 2
                 ELSE 9
               END, o.name
    ) AS occupants
      FROM core.unit_occupant uo
      JOIN core.occupant o ON o.id = uo.occupant_id
     WHERE uo.unit_id = u.id
       AND uo.deleted_at IS NULL
       AND uo.start_date <= CURRENT_DATE
       AND (uo.end_date IS NULL OR uo.end_date >= CURRENT_DATE)
       AND o.deleted_at IS NULL
  ) occs ON TRUE
 WHERE u.deleted_at IS NULL
   AND u.is_active = TRUE;
