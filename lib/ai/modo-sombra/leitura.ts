/**
 * Leitura do modo sombra — os dois transportes deste repo, uma função só.
 *
 * Espelha `lib/ai/elegibilidade/consulta-pg.ts` / `consulta-supabase.ts`: o
 * agent-engine (daemon) tem um pool `pg` na mão; os caminhos de retaguarda
 * (worker legado, envio inline do follow-up, cron do relógio) só têm o
 * `supabase-js` (service role). Em vez de duplicar o nome
 * (`lerModoSombraViaPg` / `lerModoSombraViaSupabase`), `lerModoSombra` aceita
 * os dois e escolhe o caminho por duck-typing: `pg.Pool` tem `.query()`,
 * `SupabaseClient` não.
 *
 * ─── Fail-closed por propagação ─────────────────────────────────────────────
 *
 * Nenhum dos dois caminhos engole erro aqui — quem lê `lerModoSombra` decide
 * o que fazer com a exceção. Os chamadores existentes neste repo (turno do
 * agente, worker legado, envio fixo do follow-up) tratam falha de leitura
 * como "não confirmei que está seguro, então não envio automático" —
 * fail-closed, porque um cinto de segurança que falha calado não é cinto.
 */
import type pg from "pg";
import type { SupabaseClient } from "@supabase/supabase-js";

export interface LeituraDeModoSombra {
  org: boolean;
  canal: boolean;
}

export interface LerModoSombraInput {
  organizationId: string;
  /** Vazio/ausente = não há canal para checar (ex.: preview sem canal real). */
  channelSessionId?: string | null;
}

function ehPool(client: pg.Pool | SupabaseClient): client is pg.Pool {
  return typeof (client as Partial<pg.Pool>).query === "function";
}

async function viaPg(pool: pg.Pool, input: LerModoSombraInput): Promise<LeituraDeModoSombra> {
  const { rows } = await pool.query<{ org_modo_sombra: unknown; canal_modo_sombra: unknown }>(
    `select
       (select settings->'modo_sombra' from organizations where id = $1) as org_modo_sombra,
       (select metadata->'modo_sombra' from channel_sessions where id = $2 and organization_id = $1) as canal_modo_sombra`,
    [input.organizationId, input.channelSessionId ?? null],
  );
  const r = rows[0];
  return { org: r?.org_modo_sombra === true, canal: r?.canal_modo_sombra === true };
}

async function viaSupabase(
  admin: SupabaseClient,
  input: LerModoSombraInput,
): Promise<LeituraDeModoSombra> {
  const orgQuery = admin
    .from("organizations")
    .select("settings")
    .eq("id", input.organizationId)
    .maybeSingle();
  const canalQuery = input.channelSessionId
    ? admin
        .from("channel_sessions")
        .select("metadata")
        .eq("id", input.channelSessionId)
        .eq("organization_id", input.organizationId)
        .maybeSingle()
    : null;

  const [orgRes, canalRes] = await Promise.all([
    orgQuery,
    canalQuery ?? Promise.resolve({ data: null, error: null }),
  ]);
  if (orgRes.error) throw new Error(`modo sombra: leitura da organização falhou — ${orgRes.error.message}`);
  if (canalRes.error) throw new Error(`modo sombra: leitura do canal falhou — ${canalRes.error.message}`);

  const orgSettings = (orgRes.data?.settings as Record<string, unknown> | null) ?? {};
  const canalMetadata = (canalRes.data?.metadata as Record<string, unknown> | null) ?? {};
  return { org: orgSettings["modo_sombra"] === true, canal: canalMetadata["modo_sombra"] === true };
}

/**
 * Lê `organizations.settings->'modo_sombra'` e
 * `channel_sessions.metadata->'modo_sombra'` — o par bruto que
 * `decidirModoSombra` espera em `org`/`canal`. Não decide nada; só normaliza.
 */
export async function lerModoSombra(
  client: pg.Pool | SupabaseClient,
  input: LerModoSombraInput,
): Promise<LeituraDeModoSombra> {
  return ehPool(client) ? viaPg(client, input) : viaSupabase(client, input);
}
