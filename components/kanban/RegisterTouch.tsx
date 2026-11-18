"use client";

/**
 * "Registrar toque" in the lead dossier — Berseba (migration 9005).
 *
 * One button above the timeline. It opens a small inline form: the channel
 * (e-mail, LinkedIn, WhatsApp, ligação) and an optional note. Saving posts to
 * `POST /api/v1/leads/[id]/touches`; the new line reaches the timeline by
 * realtime, and the timeline query is invalidated too so it shows up even when
 * the subscription is down.
 *
 * Inline and not a dialog: the dossier is already a sheet, and a dialog on top
 * of a sheet hides the timeline the person is about to update.
 */
import { QueryClientContext } from "@tanstack/react-query";
import { useContext, useId, useState } from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { useT } from "@/hooks/i18n/useT";
import {
  TOUCH_CHANNEL_LABELS,
  TOUCH_CHANNELS,
  TOUCH_NOTE_MAX,
  type TouchChannel,
} from "@/lib/leads/touch";
import { cn } from "@/lib/utils";

interface Props {
  leadId: string;
  /** `agent`+ and not a support session — the route's own bar. Below it, nothing is drawn. */
  canRegister: boolean;
}

export function RegisterTouch({ leadId, canRegister }: Props) {
  const t = useT();
  // Optional, like SeletorDeAtendente: a dossier rendered without the query provider
  // (tests, isolated screens) still registers the touch; it only skips the refresh.
  const queryClient = useContext(QueryClientContext);
  const noteId = useId();
  const [open, setOpen] = useState(false);
  const [channel, setChannel] = useState<TouchChannel | null>(null);
  const [note, setNote] = useState("");
  const [saving, setSaving] = useState(false);

  if (!canRegister) return null;

  function close() {
    setOpen(false);
    setChannel(null);
    setNote("");
  }

  async function save() {
    if (!channel || saving) return;
    setSaving(true);
    try {
      const res = await fetch(`/api/v1/leads/${leadId}/touches`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ channel, note: note.trim() || undefined }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as { error?: { message?: string } } | null;
        toast.error(body?.error?.message ?? t("Não foi possível registrar o toque."));
        return;
      }
      toast.success(t("Toque registrado."));
      await queryClient?.invalidateQueries({ queryKey: ["timeline", leadId] });
      close();
    } catch {
      toast.error(t("Não foi possível registrar o toque."));
    } finally {
      setSaving(false);
    }
  }

  if (!open) {
    return (
      <div className="border-b border-border py-3">
        <Button type="button" variant="outline" size="sm" onClick={() => setOpen(true)}>
          {t("Registrar toque")}
        </Button>
      </div>
    );
  }

  return (
    <section className="border-b border-border py-3" aria-labelledby="dossie-registrar-toque">
      <h3
        id="dossie-registrar-toque"
        className="mb-2 text-xs font-medium uppercase tracking-wide text-text-muted"
      >
        {t("Registrar toque")}
      </h3>
      <div role="radiogroup" aria-label={t("Canal do toque")} className="flex flex-wrap gap-2">
        {TOUCH_CHANNELS.map((c) => (
          <button
            key={c}
            type="button"
            role="radio"
            aria-checked={channel === c}
            onClick={() => setChannel(c)}
            className={cn(
              "h-11 rounded-md border px-3 text-xs lg:h-8",
              channel === c
                ? "border-accent bg-accent-soft text-accent"
                : "border-border text-text hover:border-accent hover:text-accent",
            )}
          >
            {t(TOUCH_CHANNEL_LABELS[c])}
          </button>
        ))}
      </div>
      <label htmlFor={noteId} className="mt-3 block text-xs text-text-muted">
        {t("Anotação (opcional)")}
      </label>
      <Textarea
        id={noteId}
        value={note}
        onChange={(e) => setNote(e.target.value)}
        maxLength={TOUCH_NOTE_MAX}
        rows={2}
        className="mt-1"
      />
      <div className="mt-3 flex justify-end gap-2">
        <Button type="button" variant="ghost" size="sm" onClick={close} disabled={saving}>
          {t("Cancelar")}
        </Button>
        <Button type="button" size="sm" onClick={save} disabled={!channel || saving}>
          {saving ? t("Salvando…") : t("Salvar toque")}
        </Button>
      </div>
    </section>
  );
}
