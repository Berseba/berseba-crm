-- manifest: Berseba one-time data fix — every business custom field that existed before the upstream v1.118.0 sync gets "ia_pode_ler": true, so the AI attendants keep reading what they read before; idempotent, no schema change
-- ============================================================================
-- 9008 — Existing custom fields stay readable by the AI (Berseba).
--
-- Upstream v1.118.0 (#4669, our release 2.21.0) sends a business custom field
-- (`crm_pipelines.settings.fields[]`) to the model only when it carries
-- `"ia_pode_ler": true`; a field without the key stops reaching Mi, Clara, Maya
-- and the other attendants. Matheus, 2026-11-20: release, and mark the fields
-- that exist today, so no attendant changes behaviour.
--
-- Only the business scope (`escopo` absent or "negocio") is marked: the flag is
-- read only for it (`camposLiberadosParaIa(..., 'negocio')` in the follow-up
-- block, `filtrarCamposLegiveisPelaIa` in `crm_get_lead` inside a turn).
-- A field that already has the key (true or false) is left as it is.
--
-- NOT in supabase/baseline.sql, on purpose: `update.sh` re-applies the
-- baseline on every update, and the screen DELETES the key when someone
-- unticks the box, so a baseline block would tick it again on the next update.
-- In production this ran by hand once before and once right after the 2.21.0
-- `update.sh` (BERSEBA.md). On a fresh install it finds nothing to mark.
-- ============================================================================

update public.crm_pipelines p
   set settings = jsonb_set(
         p.settings,
         '{fields}',
         (
           select jsonb_agg(
                    case
                      when jsonb_typeof(f) = 'object'
                       and not (f ? 'ia_pode_ler')
                       and coalesce(f ->> 'escopo', 'negocio') = 'negocio'
                      then f || '{"ia_pode_ler": true}'::jsonb
                      else f
                    end
                    order by ord
                  )
             from jsonb_array_elements(p.settings -> 'fields') with ordinality as e(f, ord)
         )
       )
 where jsonb_typeof(p.settings -> 'fields') = 'array'
   and exists (
         select 1
           from jsonb_array_elements(p.settings -> 'fields') f
          where jsonb_typeof(f) = 'object'
            and not (f ? 'ia_pode_ler')
            and coalesce(f ->> 'escopo', 'negocio') = 'negocio'
       );
