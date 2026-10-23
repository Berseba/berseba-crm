/**
 * THE PHOTO OF AN APPROVED ASSISTED-MODE REPLY (Berseba, migration 9004).
 *
 * In autonomous mode `send_message({ body, produto_codigo })` sends the catalog
 * photo with the text as its caption (`fotos-do-produto.ts`). In Assisted mode the
 * draft keeps the code (`ai_reply_drafts.product_code`) and the attendant approves
 * it; this module is what the approval worker runs before sending, through the
 * same pieces the autonomous turn uses: `prepararFotosDoProduto` copies the photo
 * into the conversation folder, and `channel.send({ media })` sends it.
 *
 * An approved reply is ONE physical message (`seq = 1`, one receipt). So only the
 * cover goes, the approved body is its caption, and the body must fit the caption
 * limit. Every refusal happens BEFORE anything is sent:
 * - the product is gone or inactive → `failed`, `product_not_found`;
 * - the body does not fit a caption → `failed`, `caption_too_long` (the approval
 *   route already refuses it; this is the second lock);
 * - the product has photos and none could be copied → `retry`: the attendant
 *   approved a photo, so text alone is not what they approved.
 */
import type { Queryable } from '../queue/queue';
import {
  LIMITE_DA_LEGENDA,
  prepararFotosDoProduto,
  type CopiarFoto,
  type FotoParaEnvio,
} from './fotos-do-produto';

export type ApprovedReplyPhoto =
  | { ok: true; photo: FotoParaEnvio | null }
  | {
      ok: false;
      state: 'failed' | 'retry';
      error: 'product_not_found' | 'caption_too_long' | 'product_photo_unavailable';
    };

/** Whether this body can go as the caption of a draft with a product. */
export function captionFits(body: string): boolean {
  return body.length <= LIMITE_DA_LEGENDA;
}

export async function prepareApprovedReplyPhoto(
  db: Queryable,
  copy: CopiarFoto,
  input: { organizationId: string; draftId: string; conversationId: string; body: string },
): Promise<ApprovedReplyPhoto> {
  const { rows } = await db.query<{ product_code: string | null }>(
    'select product_code from ai_reply_drafts where organization_id = $1 and id = $2',
    [input.organizationId, input.draftId],
  );
  const code = rows[0]?.product_code ?? null;
  if (code === null) return { ok: true, photo: null };
  if (!captionFits(input.body)) return { ok: false, state: 'failed', error: 'caption_too_long' };
  const prepared = await prepararFotosDoProduto(db, copy, {
    tenantId: input.organizationId,
    conversationId: input.conversationId,
    codigo: code,
    limit: 1,
  });
  if (!prepared.ok) return { ok: false, state: 'failed', error: 'product_not_found' };
  const [cover] = prepared.fotos;
  if (cover) return { ok: true, photo: cover };
  // A product without photos sends the text, as in autonomous mode.
  if (prepared.tinha === 0) return { ok: true, photo: null };
  return { ok: false, state: 'retry', error: 'product_photo_unavailable' };
}
