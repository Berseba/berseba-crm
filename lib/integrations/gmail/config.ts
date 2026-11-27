/**
 * Berseba: install-level configuration of the Gmail intake (migration 9010).
 *
 * Read-only by construction: the only scope asked is `gmail.readonly`, and nothing in this
 * module sends mail. Two allowlists, both required, fail closed:
 * - `GMAIL_INTAKE_ORG_IDS`: the organizations that have the screen and the cron;
 * - `GMAIL_INTAKE_ACCOUNTS`: the only mailboxes that may be connected (the partners' company
 *   inboxes). A consent for any other account is refused at the callback.
 *
 * The OAuth app is `GMAIL_INTAKE_CLIENT_ID`/`GMAIL_INTAKE_CLIENT_SECRET` when set, else the
 * installation's Google app (the one the agenda uses), with this module's own redirect URI.
 * Never throws.
 */
import { createHmac } from "node:crypto";

import { configuracaoDoGoogle } from "@/lib/agenda/google/config";
import { env } from "@/lib/env";
import type { CapacidadeDaOrganizacao } from "@/lib/organizacao/capacidades";

export const ESCOPO_GMAIL_LEITURA = "https://www.googleapis.com/auth/gmail.readonly";
export const CAMINHO_DO_CALLBACK_GMAIL = "/api/v1/gmail/callback";

export interface GmailIntakeConfig {
  orgIds: ReadonlySet<string>;
  contas: ReadonlySet<string>;
}

export interface AppDoGmail {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const EMAIL = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

function lista(bruto: string | undefined, valido: RegExp): Set<string> {
  return new Set(
    (bruto ?? "")
      .split(",")
      .map((v) => v.trim().toLowerCase())
      .filter((v) => valido.test(v)),
  );
}

/** Pure: raw env values → the config, or `null` when the intake is off. */
export function parseGmailIntakeConfig(raw: { orgIds?: string; contas?: string }): GmailIntakeConfig | null {
  const orgIds = lista(raw.orgIds, UUID);
  const contas = lista(raw.contas, EMAIL);
  if (orgIds.size === 0 || contas.size === 0) return null;
  return { orgIds, contas };
}

export function gmailIntakeConfig(): GmailIntakeConfig | null {
  return parseGmailIntakeConfig({ orgIds: env.GMAIL_INTAKE_ORG_IDS, contas: env.GMAIL_INTAKE_ACCOUNTS });
}

/** The config when this organization has the Gmail intake, else `null`. */
export function gmailIntakeConfigFor(organizationId: string): GmailIntakeConfig | null {
  const config = gmailIntakeConfig();
  return config?.orgIds.has(organizationId.toLowerCase()) ? config : null;
}

/** The capability of the e-mail screen's door (the app layout sets it). */
export function capacidadesDoGmail(organizationId: string): CapacidadeDaOrganizacao[] {
  return gmailIntakeConfigFor(organizationId) ? ["emails_gmail"] : [];
}

export function contaPermitida(config: GmailIntakeConfig, email: string | null | undefined): boolean {
  return Boolean(email && config.contas.has(email.trim().toLowerCase()));
}

export function enderecoDeRetornoDoGmail(urlDaAplicacao: string = env.NEXT_PUBLIC_APP_URL): string {
  return new URL(CAMINHO_DO_CALLBACK_GMAIL, urlDaAplicacao).toString();
}

/** True when the Gmail flow has its own OAuth client (not the agenda's). */
export function temClienteProprio(): boolean {
  return Boolean(env.GMAIL_INTAKE_CLIENT_ID.trim() && env.GMAIL_INTAKE_CLIENT_SECRET.trim());
}

/** The OAuth app for the Gmail consent, or `null` when there is none. */
export async function appDoGmail(): Promise<AppDoGmail | null> {
  const redirectUri = enderecoDeRetornoDoGmail();
  const clientId = env.GMAIL_INTAKE_CLIENT_ID.trim();
  const clientSecret = env.GMAIL_INTAKE_CLIENT_SECRET.trim();
  if (clientId && clientSecret) return { clientId, clientSecret, redirectUri };
  const daInstalacao = await configuracaoDoGoogle();
  if (!daInstalacao) return null;
  return { clientId: daInstalacao.clientId, clientSecret: daInstalacao.clientSecret, redirectUri };
}

/** The consent URL: read-only Gmail, offline, the account chooser kept up. */
export function urlDeConsentimentoDoGmail(app: AppDoGmail, opcoes: { state: string; contaSugerida?: string | null }): string {
  const parametros = new URLSearchParams({
    client_id: app.clientId,
    redirect_uri: app.redirectUri,
    response_type: "code",
    scope: ESCOPO_GMAIL_LEITURA,
    // Same three as the agenda (lib/agenda/google/oauth.ts): offline for a refresh token,
    // consent so it comes back on every reconnection, select_account so the right inbox is picked.
    access_type: "offline",
    prompt: "consent select_account",
    include_granted_scopes: "false",
    state: opcoes.state,
  });
  const conta = opcoes.contaSugerida?.trim();
  if (conta) parametros.set("login_hint", conta);
  return `https://accounts.google.com/o/oauth2/v2/auth?${parametros.toString()}`;
}

/**
 * The state of this flow is signed with its own key, derived from INTERNAL_SECRET, so an agenda
 * state never opens it. A missing or short base secret gives "" and `emitirEstado` refuses it, as
 * the agenda does: the derivation must never lengthen a weak secret into a valid-looking key.
 */
export function segredoDoEstadoDoGmail(): string {
  const base = (env.INTERNAL_SECRET ?? "").trim();
  if (base.length < 16) return "";
  return createHmac("sha256", base).update("gmail-intake").digest("hex");
}
