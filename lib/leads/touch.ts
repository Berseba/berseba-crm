/**
 * Berseba (migration 9005): a "touch" is one contact a person on the team made
 * with a lead — an e-mail, a LinkedIn message, a WhatsApp message or a call.
 *
 * It exists because the prospecting routine reaches leads outside the CRM's own
 * channels, and the weekly goal ("125 touches") had nothing to count. The row
 * is a `crm_lead_activities` line of type `touch`, and the contract view
 * `analytics.v1_contagem_dia` counts it.
 *
 * The note is free text the person types, so it may name someone: it goes only
 * to the `reason` (rendered on the timeline, redacted by the LGPD cascade like
 * any other reason) and never to the audit log or the analytics view.
 */
import { z } from "zod";

export const TOUCH_CHANNELS = ["email", "linkedin", "whatsapp", "call"] as const;
export type TouchChannel = (typeof TOUCH_CHANNELS)[number];

/** What the team reads. Portuguese: it is UI copy. */
export const TOUCH_CHANNEL_LABELS: Record<TouchChannel, string> = {
  email: "E-mail",
  linkedin: "LinkedIn",
  whatsapp: "WhatsApp",
  call: "Telefonema",
};

export const TOUCH_NOTE_MAX = 500;

export const touchSchema = z
  .object({
    channel: z.enum(TOUCH_CHANNELS),
    note: z
      .string()
      .trim()
      .max(TOUCH_NOTE_MAX)
      .optional()
      .transform((note) => (note ? note : undefined)),
  })
  .strict();

export type TouchInput = z.infer<typeof touchSchema>;

/** "E-mail" or "E-mail: <note>" — the line under "Toque registrado". */
export function touchReason({ channel, note }: TouchInput): string {
  const label = TOUCH_CHANNEL_LABELS[channel];
  return note ? `${label}: ${note}` : label;
}
