import { describe, expect, it, vi } from "vitest";

import { captionFits, prepareApprovedReplyPhoto } from "./approved-reply-photo";
import { LIMITE_DA_LEGENDA } from "./fotos-do-produto";

const ORG = "aaaaaaaa-0000-4000-8000-000000000001";
const DRAFT = "dddddddd-0000-4000-8000-000000000001";
const PRODUCT = "bbbbbbbb-0000-4000-8000-000000000001";
const CONVERSATION = "cccccccc-0000-4000-8000-000000000001";
const COVER = `${ORG}/${PRODUCT}/11111111-2222-4333-8444-555555555555.jpg`;
const SECOND = `${ORG}/${PRODUCT}/66666666-7777-4888-8999-000000000000.png`;

/** Answers the draft read, then the catalog read, in that order. */
function database(
  productCode: string | null,
  product: { id: string; fotos: string[] | null } | null,
) {
  const query = vi.fn(async (sql: string, _values: unknown[]) => {
    if (sql.includes("from ai_reply_drafts")) return { rows: [{ product_code: productCode }] };
    if (sql.includes("from catalog_products")) return { rows: product ? [product] : [] };
    throw new Error(`unexpected query: ${sql}`);
  });
  return { db: { query } as never, query };
}

const input = (body = "Olha as mechas morena que fizemos semana passada!") => ({
  organizationId: ORG,
  draftId: DRAFT,
  conversationId: CONVERSATION,
  body,
});

describe("prepareApprovedReplyPhoto — the photo of an approved Assisted-mode reply", () => {
  it("a draft without a product sends text only and touches neither the catalog nor Storage", async () => {
    const { db, query } = database(null, null);
    const copy = vi.fn(async () => true);

    expect(await prepareApprovedReplyPhoto(db, copy, input())).toEqual({ ok: true, photo: null });
    expect(query).toHaveBeenCalledTimes(1);
    expect(query.mock.calls[0]?.[1]).toEqual([ORG, DRAFT]);
    expect(copy).not.toHaveBeenCalled();
  });

  it("copies ONLY the cover into the conversation folder: an approved reply is one message", async () => {
    const { db, query } = database("mechas-morena", { id: PRODUCT, fotos: [COVER, SECOND] });
    const copy = vi.fn(async () => true);

    const result = await prepareApprovedReplyPhoto(db, copy, input());

    expect(query.mock.calls[1]?.[1]).toEqual([ORG, "mechas-morena"]);
    expect(copy.mock.calls).toEqual([
      [COVER, `${ORG}/${CONVERSATION}/catalogo-11111111-2222-4333-8444-555555555555.jpg`],
    ]);
    expect(result).toEqual({
      ok: true,
      photo: {
        storagePath: `${ORG}/${CONVERSATION}/catalogo-11111111-2222-4333-8444-555555555555.jpg`,
        mime: "image/jpeg",
      },
    });
  });

  it("an invalid or deactivated code fails the send before anything is copied or sent", async () => {
    const { db } = database("nao-existe", null);
    const copy = vi.fn(async () => true);

    expect(await prepareApprovedReplyPhoto(db, copy, input())).toEqual({
      ok: false,
      state: "failed",
      error: "product_not_found",
    });
    expect(copy).not.toHaveBeenCalled();
  });

  it("a body longer than a caption fails before the catalog is read", async () => {
    const { db, query } = database("mechas-morena", { id: PRODUCT, fotos: [COVER] });
    const copy = vi.fn(async () => true);

    expect(
      await prepareApprovedReplyPhoto(db, copy, input("a".repeat(LIMITE_DA_LEGENDA + 1))),
    ).toEqual({ ok: false, state: "failed", error: "caption_too_long" });
    expect(query).toHaveBeenCalledTimes(1);
    expect(copy).not.toHaveBeenCalled();
  });

  it("a photo that could not be copied is retried, never downgraded to text the attendant did not approve", async () => {
    const { db } = database("mechas-morena", { id: PRODUCT, fotos: [COVER] });

    expect(await prepareApprovedReplyPhoto(db, vi.fn(async () => false), input())).toEqual({
      ok: false,
      state: "retry",
      error: "product_photo_unavailable",
    });
  });

  it("a product with no photo of its own sends the text, as the autonomous turn does", async () => {
    const foreign = `aaaaaaaa-0000-4000-8000-000000000002/${PRODUCT}/11111111-2222-4333-8444-555555555555.jpg`;
    const { db } = database("mechas-morena", { id: PRODUCT, fotos: [foreign] });
    const copy = vi.fn(async () => true);

    expect(await prepareApprovedReplyPhoto(db, copy, input())).toEqual({ ok: true, photo: null });
    expect(copy).not.toHaveBeenCalled();
  });
});

describe("captionFits", () => {
  it("accepts exactly the caption limit and refuses one character more", () => {
    expect(captionFits("a".repeat(LIMITE_DA_LEGENDA))).toBe(true);
    expect(captionFits("a".repeat(LIMITE_DA_LEGENDA + 1))).toBe(false);
  });
});
