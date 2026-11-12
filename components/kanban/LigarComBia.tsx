"use client";
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { toast } from "sonner";

import { useT } from "@/hooks/i18n/useT";
import { Phone } from "@/lib/ui/icons";

/**
 * Berseba: "Ligar com a Bia" (Berseba/berseba issue #232). The Bia, Voz's agent, calls the lead's
 * contact over WhatsApp and leaves the report on this card's timeline a few seconds after the call.
 *
 * Only where Voz is on for the organization (`GET /api/v1/voz/calls` → `ativo`); anywhere else the
 * component draws nothing, not even a disabled button. Two clicks: the first one asks, the second
 * one calls, because the phone rings in a real person's pocket. The refusals (opted out, already
 * calling, paused, daily limit) come back as the sentence the route wrote.
 */
interface Props {
  leadId: string;
  /** The lead's contact phone; without one there is nothing to call. */
  phone?: string | null;
}

export function LigarComBia({ leadId, phone }: Props) {
  const t = useT();
  const [etapa, setEtapa] = useState<"pronto" | "confirmar" | "pedindo" | "pedida">("pronto");
  const { data: ativo } = useQuery({
    queryKey: ["voz-ativa"],
    queryFn: async () => {
      const res = await fetch("/api/v1/voz/calls");
      if (!res.ok) return false;
      const json = (await res.json()) as { data?: { ativo?: boolean } };
      return json.data?.ativo === true;
    },
    staleTime: 5 * 60_000,
  });

  if (!ativo || !phone?.trim()) return null;

  async function ligar() {
    setEtapa("pedindo");
    try {
      const res = await fetch("/api/v1/voz/calls", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ lead_id: leadId }),
      });
      const json = (await res.json().catch(() => null)) as { error?: { message?: string } } | null;
      if (!res.ok) throw new Error(json?.error?.message ?? t("Não foi possível pedir a ligação."));
      setEtapa("pedida");
      toast.success(t("A Bia vai ligar em instantes. O resumo aparece na linha do tempo."));
    } catch (err) {
      setEtapa("pronto");
      toast.error(err instanceof Error ? err.message : t("Não foi possível pedir a ligação."));
    }
  }

  const confirmando = etapa === "confirmar";
  return (
    <div className="mt-3 flex items-center gap-2" data-testid="ligar-com-bia">
      <button
        type="button"
        onClick={() => (confirmando ? void ligar() : setEtapa("confirmar"))}
        disabled={etapa === "pedindo" || etapa === "pedida"}
        aria-busy={etapa === "pedindo"}
        className="group flex min-w-0 flex-1 items-center gap-2.5 rounded-md border border-border bg-muted/40 px-3 py-2 text-left transition-colors hover:border-primary/40 hover:bg-muted disabled:cursor-not-allowed disabled:opacity-70"
      >
        <Phone size={16} weight="regular" className="shrink-0 text-text-muted" aria-hidden />
        <span className="min-w-0 flex-1">
          <span className="block text-xs font-medium text-text">
            {etapa === "pedindo"
              ? t("Pedindo…")
              : etapa === "pedida"
                ? t("A Bia está ligando")
                : confirmando
                  ? t("Confirmar: a Bia liga agora")
                  : t("Ligar com a Bia")}
          </span>
          <span className="block text-[11px] text-text-muted">
            {etapa === "pedida"
              ? t("O resumo aparece na linha do tempo quando a ligação terminar.")
              : t("A Bia liga pelo WhatsApp e deixa o resumo aqui.")}
          </span>
        </span>
      </button>
      {confirmando && (
        <button
          type="button"
          onClick={() => setEtapa("pronto")}
          className="shrink-0 px-1 text-xs text-text-muted underline-offset-2 hover:text-text hover:underline"
        >
          {t("Cancelar")}
        </button>
      )}
    </div>
  );
}
