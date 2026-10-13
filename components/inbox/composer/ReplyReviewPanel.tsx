"use client";
import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { apiClient } from "@/lib/api/client";
import { showApiError } from "@/components/feedback/ApiErrorToast";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Input } from "@/components/ui/input";
import { useT } from "@/hooks/i18n/useT";
import { sugestaoParaMostrar } from "@/lib/agent-engine/agent/sugestao-de-resposta";
type Draft = {
  id: string;
  revision: string;
  status: string;
  original_body: string | null;
  edited_body: string | null;
  error_code: string | null;
  proposals: Array<{ tool: string; arguments: unknown }>;
  /** Catalog product the agent attached (Berseba, migration 9001). */
  product_code?: string | null;
};
type DraftProduct = { code: string; name: string | null; thumbnail_url: string | null } | null;
/** WhatsApp's caption cap — the same `LIMITE_DA_LEGENDA` the send enforces. */
const CAPTION_LIMIT = 1024;
export function ReplyReviewPanel({
  conversationId,
  disabled,
}: {
  conversationId: string;
  disabled?: boolean;
}) {
  const t = useT(),
    qc = useQueryClient(),
    key = ["reply-drafts", conversationId];
  const query = useQuery({
    queryKey: key,
    queryFn: () =>
      apiClient.get<{ data: { drafts: Draft[] } }>(
        `/api/v1/conversations/${conversationId}/draft-reply`,
      ),
    refetchInterval: 4000,
    retry: false,
  });
  const [edits, setEdits] = useState<Record<string, string>>({}),
    [feedback, setFeedback] = useState(""),
    [busy, setBusy] = useState(false),
    [notice, setNotice] = useState<{
      draftId: string;
      message: string;
      kind: "success" | "error";
    } | null>(null);
  // Antes: `drafts[0]`, o mais recente, QUALQUER que fosse o estado dele — então
  // uma sugestão rejeitada ficava na tela para sempre, sem botão de fechar.
  const draft = sugestaoParaMostrar(query.data?.data.drafts);
  const body = draft ? (edits[draft.id] ?? draft.edited_body ?? draft.original_body ?? "") : "";
  // The signed thumbnail lives an hour; fetched once per draft, not on every poll.
  const productCode = draft?.product_code ?? null;
  const product = useQuery({
    queryKey: ["reply-draft-product", draft?.id],
    queryFn: () =>
      apiClient.get<{ data: { product: DraftProduct } }>(`/api/v1/ai/replies/${draft!.id}/product`),
    enabled: productCode !== null,
    staleTime: 30 * 60 * 1000,
    retry: false,
  });
  const productInfo = productCode ? (product.data?.data.product ?? null) : null;
  const captionTooLong = productCode !== null && body.trim().length > CAPTION_LIMIT;
  async function generate() {
    setNotice(null);
    setBusy(true);
    try {
      await apiClient.post(`/api/v1/conversations/${conversationId}/draft-reply`, {});
      await qc.invalidateQueries({ queryKey: key });
    } catch (e) {
      showApiError(e);
    } finally {
      setBusy(false);
    }
  }
  async function decide(action: "approve" | "reject") {
    if (!draft) return;
    setBusy(true);
    setNotice(null);
    try {
      await apiClient.post(`/api/v1/ai/replies/${draft.id}`, {
        action,
        revision: draft.revision,
        body,
        feedback,
      });
      setNotice({
        draftId: draft.id,
        kind: "success",
        message:
          action === "approve"
            ? t("Resposta aprovada. Acompanhe o envio aqui.")
            : t("Sugestão rejeitada. O feedback será usado na próxima sugestão."),
      });
      await qc.invalidateQueries({ queryKey: key });
    } catch (e) {
      showApiError(e);
      setNotice({
        draftId: draft.id,
        kind: "error",
        message: t(
          "Sua edição foi preservada. Confira se a conversa mudou antes de aprovar novamente.",
        ),
      });
      await qc.invalidateQueries({ queryKey: key });
    } finally {
      setBusy(false);
    }
  }
  const statuses: Record<string, string> = {
    generating: "Preparando sugestão…",
    pending: "Sugestão para revisar",
    approved: "Resposta aprovada: aguardando envio",
    sending: "Enviando resposta aprovada…",
    sent: "Resposta aprovada enviada",
    dismissed: "Sugestão rejeitada",
    stale: "Sugestão obsoleta: a conversa mudou",
    failed: "Não foi possível concluir a sugestão ou o envio",
  };
  return (
    <section
      className="mb-3 space-y-2 rounded-md border bg-muted/30 p-3"
      aria-label={t("Assistência do agente")}
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm font-medium">
          {t(draft ? (statuses[draft.status] ?? "Assistência do agente") : "Assistência do agente")}
        </p>
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={disabled || busy}
          onClick={generate}
        >
          {t(busy ? "Preparando…" : "Sugerir resposta")}
        </Button>
      </div>
      {draft && (
        <>
          <p className="text-xs text-muted-foreground">
            {productCode
              ? t(
                  "Aprovar envia a foto do produto com este texto como legenda. Não altera dados, agenda ou a autonomia do agente.",
                )
              : t(
                  "Aprovar envia somente este texto. Não altera dados, agenda ou a autonomia do agente.",
                )}
          </p>
          {productCode && (
            <div
              className="flex items-center gap-3 rounded-md border bg-background p-2"
              data-testid="reply-draft-product"
            >
              {productInfo?.thumbnail_url ? (
                // Short-lived signed URL from another host: `next/image` would need an allowlist at build time.
                // eslint-disable-next-line @next/next/no-img-element
                <img
                  src={productInfo.thumbnail_url}
                  alt={t("Foto do produto")}
                  className="h-14 w-14 shrink-0 rounded-md object-cover"
                />
              ) : (
                <div className="h-14 w-14 shrink-0 rounded-md bg-muted" aria-hidden="true" />
              )}
              <div className="min-w-0 text-xs">
                <p className="truncate font-medium">{productInfo?.name ?? productCode}</p>
                <p className="text-muted-foreground">
                  {product.isSuccess && productInfo?.name === null
                    ? t("Este produto não está mais ativo no catálogo. A resposta não será enviada.")
                    : t("Foto do catálogo, enviada junto com a resposta.")}
                </p>
              </div>
            </div>
          )}
          {body && (
            <Textarea
              aria-label={t("Resposta sugerida")}
              value={body}
              onChange={(e) => setEdits({ ...edits, [draft.id]: e.target.value })}
              disabled={disabled || busy || draft.status !== "pending"}
              rows={3}
            />
          )}
          {draft.proposals.length > 0 && (
            <details className="text-xs">
              <summary>{t("Ações propostas: precisam de autorização separada")}</summary>
              <p>{t("Abra a ação correspondente no CRM ou na agenda para confirmar.")}</p>
              <ul>
                {draft.proposals.map((p, i) => (
                  <li key={i}>{p.tool}</li>
                ))}
              </ul>
            </details>
          )}
          {draft.status === "pending" && captionTooLong && (
            <p role="alert" className="text-xs text-destructive">
              {t("A legenda da foto aceita até 1.024 caracteres. Encurte o texto para enviar.")}
            </p>
          )}
          {draft.status === "pending" && (
            <>
              <Input
                aria-label={t("Feedback para a próxima sugestão")}
                placeholder={t("Feedback para a próxima sugestão")}
                value={feedback}
                onChange={(e) => setFeedback(e.target.value)}
                maxLength={1000}
              />
              <div className="flex gap-2">
                <Button
                  type="button"
                  size="sm"
                  disabled={disabled || busy || !body.trim() || captionTooLong}
                  onClick={() => decide("approve")}
                >
                  {t("Aprovar e enviar")}
                </Button>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  disabled={disabled || busy}
                  onClick={() => decide("reject")}
                >
                  {t("Rejeitar")}
                </Button>
              </div>
            </>
          )}
          {draft.status === "failed" && (
            <p className="text-xs">
              {t("Confira a configuração do agente e tente gerar novamente.")}
            </p>
          )}
        </>
      )}
      {/*
        A confirmação da rejeição ("o feedback será usado na próxima sugestão")
        estava amarrada a `draft` existir. Agora a rejeitada some da tela — que é
        o conserto —, e sem esta mudança a confirmação sumiria junto com ela: a
        pessoa clicaria em Rejeitar e a tela apenas esvaziaria, sem dizer nada.
        Quando ainda há sugestão, o aviso continua amarrado a ela.
      */}
      {notice &&
        (!draft ||
          (notice.draftId === draft.id &&
            (notice.kind === "error" ||
              ["approved", "sending", "sent", "dismissed"].includes(draft.status)))) && (
          <p role="status" className="text-xs">
            {notice.message}
          </p>
        )}
    </section>
  );
}
