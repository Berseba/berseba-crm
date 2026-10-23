"use client";
import { useState, useSyncExternalStore } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { apiClient } from "@/lib/api/client";
import { showApiError } from "@/components/feedback/ApiErrorToast";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Input } from "@/components/ui/input";
import { useT } from "@/hooks/i18n/useT";
import { CaretDown, CaretUp } from "@/lib/ui/icons";
import { motivoDoVeto, sugestaoParaMostrar } from "@/lib/agent-engine/agent/sugestao-de-resposta";
// Berseba: the attendant's choice to collapse the panel, remembered per browser.
// An external store (not a `useState` initializer) so the server snapshot is
// always "expanded" and hydration never compares against localStorage; see
// `lib/theme.tsx`. The in-memory value covers a browser that blocks storage.
const COLLAPSED_KEY = "berseba.reply_review.collapsed";
const collapsedListeners = new Set<() => void>();
let collapsedInMemory: boolean | null = null;
function getCollapsedSnapshot(): boolean {
  if (collapsedInMemory === null) {
    try {
      collapsedInMemory = window.localStorage.getItem(COLLAPSED_KEY) === "1";
    } catch {
      collapsedInMemory = false;
    }
  }
  return collapsedInMemory;
}
function getCollapsedServerSnapshot(): boolean {
  return false;
}
function subscribeCollapsed(listener: () => void) {
  collapsedListeners.add(listener);
  return () => {
    collapsedListeners.delete(listener);
  };
}
function setCollapsedPreference(next: boolean) {
  collapsedInMemory = next;
  try {
    window.localStorage.setItem(COLLAPSED_KEY, next ? "1" : "0");
  } catch {
    /* storage unavailable: the in-memory value still holds for this tab */
  }
  collapsedListeners.forEach((listener) => listener());
}
type Draft = {
  id: string;
  revision: string;
  status: string;
  original_body: string | null;
  edited_body: string | null;
  error_code: string | null;
  proposals: Array<{ tool: string; arguments: unknown }>;
  /** Berseba: catalog product the agent attached (migration 9004). */
  product_code?: string | null;
};
type DraftProduct = {
  code: string;
  name: string | null;
  has_photo: boolean;
  thumbnail_url: string | null;
} | null;

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
  const collapsed = useSyncExternalStore(
    subscribeCollapsed,
    getCollapsedSnapshot,
    getCollapsedServerSnapshot,
  );
  const toggleCollapsed = () => setCollapsedPreference(!collapsed);
  // Antes: `drafts[0]`, o mais recente, QUALQUER que fosse o estado dele — então
  // uma sugestão rejeitada ficava na tela para sempre, sem botão de fechar.
  const draft = sugestaoParaMostrar(query.data?.data.drafts);
  const body = draft ? (edits[draft.id] ?? draft.edited_body ?? draft.original_body ?? "") : "";
  // Berseba: the product photo. The signed thumbnail lives an hour; fetched once
  // per draft, not on every poll.
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
  // Known only once the route answered: `name: null` = deactivated since the draft.
  const productGone = product.isSuccess && productInfo !== null && productInfo.name === null;
  const productWithoutPhoto = productInfo !== null && productInfo.name !== null && !productInfo.has_photo;
  const sendsPhoto = productCode !== null && !productGone && !productWithoutPhoto;
  const captionTooLong = productCode !== null && body.trim().length > CAPTION_LIMIT;
  // A causa do veto, em linguagem de quem opera (issue #2975): sem código
  // conhecido, a frase genérica de sempre continua sendo a verdade.
  const motivo = draft ? motivoDoVeto(draft.error_code) : null;
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
      className="mb-2 space-y-2 rounded-md border bg-muted/30 px-3 py-2"
      aria-label={t("Assistência do agente")}
    >
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <p className="text-sm font-medium">
          {t(draft ? (statuses[draft.status] ?? "Assistência do agente") : "Assistência do agente")}
        </p>
        {draft && collapsed && body ? (
          // Mouse shortcut only: the caret below is the labelled control.
          <button
            type="button"
            tabIndex={-1}
            aria-hidden
            className="min-w-0 flex-1 truncate text-left text-xs text-muted-foreground hover:text-foreground"
            onClick={toggleCollapsed}
            title={t("Mostrar sugestão")}
          >
            {body}
          </button>
        ) : (
          <span className="flex-1" />
        )}
        {draft && (draft.status !== "failed" || body) && (
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="h-7 w-7 shrink-0"
            aria-label={t(collapsed ? "Mostrar sugestão" : "Recolher sugestão")}
            aria-expanded={!collapsed}
            onClick={toggleCollapsed}
          >
            {collapsed ? <CaretUp size={16} aria-hidden /> : <CaretDown size={16} aria-hidden />}
          </Button>
        )}
        <Button
          className="shrink-0"
          type="button"
          variant="outline"
          size="sm"
          disabled={disabled || busy}
          onClick={generate}
        >
          {t(busy ? "Preparando…" : "Sugerir resposta")}
        </Button>
      </div>
      {/* Collapsed hides the draft, never the reason a draft failed. */}
      {draft && (!collapsed || draft.status === "failed") && (
        <>
          {productCode && !collapsed && (
            <div className="flex items-center gap-2" data-testid="reply-draft-product">
              {productInfo?.thumbnail_url ? (
                // Short-lived signed URL from another host: `next/image` would need an allowlist at build time.
                // eslint-disable-next-line @next/next/no-img-element
                <img
                  src={productInfo.thumbnail_url}
                  alt={t("Foto do produto")}
                  className="h-10 w-10 shrink-0 rounded-md object-cover"
                />
              ) : (
                <div className="h-10 w-10 shrink-0 rounded-md bg-muted" aria-hidden="true" />
              )}
              <div className="min-w-0 text-xs">
                <p className="truncate font-medium">{productInfo?.name ?? productCode}</p>
                <p className="text-muted-foreground">
                  {productGone
                    ? t("Este produto não está mais ativo no catálogo. A resposta não será enviada.")
                    : productWithoutPhoto
                      ? t("Este produto não tem foto no catálogo. Vai só o texto.")
                      : t("Foto do catálogo, enviada junto com a resposta.")}
                </p>
              </div>
            </div>
          )}
          {body && !collapsed && (
            <Textarea
              aria-label={t("Resposta sugerida")}
              value={body}
              onChange={(e) => setEdits({ ...edits, [draft.id]: e.target.value })}
              disabled={disabled || busy || draft.status !== "pending"}
              rows={2}
              className="max-h-40 min-h-[56px] px-3 py-2"
            />
          )}
          {draft.proposals.length > 0 && !collapsed && (
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
            <div className="flex flex-wrap items-center gap-2">
              <Input
                aria-label={t("Feedback para a próxima sugestão")}
                placeholder={t("Feedback para a próxima sugestão")}
                value={feedback}
                onChange={(e) => setFeedback(e.target.value)}
                maxLength={1000}
                className="h-8 min-w-[12rem] flex-1 px-3"
              />
              <Button
                type="button"
                size="sm"
                disabled={disabled || busy || !body.trim() || captionTooLong || productGone}
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
          )}
          {draft.status === "pending" && (
            <p className="text-xs text-muted-foreground">
              {sendsPhoto
                ? t(
                    "Aprovar envia a foto do produto com este texto como legenda. Não altera dados, agenda ou a autonomia do agente.",
                  )
                : t(
                    "Aprovar envia somente este texto. Não altera dados, agenda ou a autonomia do agente.",
                  )}
            </p>
          )}
          {draft.status === "failed" && (
            <p className="text-xs">
              {/* Berseba: a product failure names its cause instead of the agent setup. */}
              {draft.error_code === "product_not_found"
                ? t("O produto desta sugestão não está mais ativo no catálogo. Nada foi enviado.")
                : draft.error_code === "caption_too_long"
                  ? t("O texto passou do limite da legenda da foto. Nada foi enviado.")
                  : draft.error_code === "product_photo_unavailable"
                    ? t(
                        "Não foi possível preparar a foto do produto. Nada foi enviado; gere a sugestão de novo.",
                      )
                    : motivo
                      ? t(motivo.texto)
                      : t("Confira a configuração do agente e tente gerar novamente.")}
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
