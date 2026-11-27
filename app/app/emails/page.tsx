import Link from "next/link";
import { notFound, redirect } from "next/navigation";

import { requireAuth, resolveActiveOrg } from "@/lib/auth/server";
import { ROLE_RANK } from "@/lib/auth/types";
import { rotuloDoContato } from "@/lib/contacts/rotulo-do-contato";
import { tagDeIdioma } from "@/lib/i18n/datas";
import { duracaoCurta, minutosDeEspera } from "@/lib/operacao/regras";
import { traduzir } from "@/lib/i18n/dicionario";
import { gmailIntakeConfigFor } from "@/lib/integrations/gmail/config";
import { linkDoGmail } from "@/lib/integrations/gmail/message";
import { lerTelaDeEmails } from "@/lib/integrations/gmail/tela";

export const dynamic = "force-dynamic";

function errosDaVolta(t: (texto: string) => string): Record<string, string> {
  return {
    conexao_cancelada: t("A conexão foi cancelada na tela do Google."),
    retorno_nao_verificavel: t("Não foi possível confirmar a volta do Google. Tente conectar de novo."),
    retorno_incompleto: t("O Google voltou sem a autorização. Tente conectar de novo."),
    gmail_desligado: t("A leitura de e-mails não está ligada para esta empresa."),
    google_nao_configurado: t("O app do Google desta instalação não está configurado."),
    segredo_indisponivel: t("Falta a chave interna desta instalação para conectar com segurança."),
    troca_de_codigo_falhou: t("O Google recusou a autorização. Tente conectar de novo."),
    permissao_incompleta: t("Marque a permissão de ler os e-mails na tela do Google."),
    sem_renovacao: t("O Google não devolveu a permissão contínua. Tente conectar de novo."),
    conta_indisponivel: t("Não foi possível ler qual é a conta do Gmail."),
    conta_nao_permitida: t("Esta conta de e-mail não está na lista das caixas permitidas."),
    cifra_indisponivel: t("Não foi possível guardar a conexão com segurança."),
    conta_em_uso: t("Esta conta de e-mail já está conectada por outra pessoa."),
    gravar_falhou: t("Não foi possível salvar. Tente de novo."),
  };
}

function situacoes(t: (texto: string) => string): Record<string, string> {
  return {
    healthy: t("Lendo"),
    token_expired: t("Reconecte"),
    scope_missing: t("Falta permissão"),
    disconnected: t("Desconectada"),
    error: t("Com erro"),
  };
}

function quando(iso: string, tag: string): string {
  return new Intl.DateTimeFormat(tag, {
    timeZone: "America/Sao_Paulo",
    day: "2-digit",
    month: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(iso));
}

/**
 * Berseba (migration 9010): the partners' e-mail, read from Gmail, next to the CRM's contacts and
 * deals. Admins of an organization listed in GMAIL_INTAKE_ORG_IDS only. Read-only: replying is
 * done in Gmail for now ("Abrir no Gmail").
 */
export default async function Page({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const user = await requireAuth();
  const org = await resolveActiveOrg(user);
  if (!org) redirect("/app");
  if (!gmailIntakeConfigFor(org.orgId) || ROLE_RANK[org.role] < ROLE_RANK.admin) notFound();
  const t = (texto: string) => traduzir(texto, user.idioma);
  const params = await searchParams;
  const tag = tagDeIdioma(user.idioma);

  const agora = new Date();
  const { caixas, conversas, fila, filaCortada, filaFalhou, nomes, negocios } = await lerTelaDeEmails(org.orgId, agora);
  const redes: Record<string, string> = {
    whatsapp: t("WhatsApp"),
    instagram: t("Instagram"),
    facebook: t("Facebook"),
    telegram: t("Telegram"),
  };
  const contaDaCaixa = new Map(caixas.map((c) => [c.id, c.account_email]));
  const minhas = caixas.filter((c) => c.user_id === user.id);
  const minha = minhas.find((c) => c.status === "healthy") ?? minhas[0];

  const erros = errosDaVolta(t);
  const situacao = situacoes(t);
  const erro = params.erro ? (erros[params.erro] ?? erros.gravar_falhou) : null;

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-4">
      <div>
        <h1 className="text-xl font-semibold">{t("E-mails")}</h1>
        <p className="text-sm text-text-muted">
          {t("Os e-mails das caixas conectadas, ligados ao contato e ao negócio. Só leitura: para responder, abra no Gmail.")}
        </p>
      </div>

      {erro ? <p className="rounded-md border border-border bg-surface px-3 py-2 text-sm" role="alert">{erro}</p> : null}
      {params.desconectado ? (
        <p className="rounded-md border border-border bg-surface px-3 py-2 text-sm">
          {t("Gmail desconectado: o CRM parou de ler. Para tirar o acesso também no Google, remova o app em myaccount.google.com/permissions.")}
        </p>
      ) : null}
      {params.ok ? <p className="rounded-md border border-border bg-surface px-3 py-2 text-sm">{t("Gmail conectado. Os e-mails chegam em até 5 minutos.")}</p> : null}

      <section className="min-w-0">
        <h2 className="mb-1 text-sm font-semibold">
          {t("Precisa responder")} <span className="text-text-muted">({fila.length})</span>
        </h2>
        <p className="mb-2 text-xs text-text-muted">
          {t("Clientes que escreveram por e-mail por último sem resposta de nenhum sócio, e conversas esperando uma pessoa, pela mesma regra da Operação do dia. A mais antiga primeiro.")}
        </p>
        {filaFalhou ? (
          <p className="mb-2 rounded-md border border-border bg-surface px-3 py-2 text-sm" role="alert">
            {t("Não foi possível ler toda a fila agora. Recarregue a página em instantes.")}
          </p>
        ) : null}
        {filaCortada ? (
          <p className="mb-2 text-xs text-text-muted">{t("A lista chegou ao limite de leitura: pode haver esperas mais antigas que não aparecem aqui.")}</p>
        ) : null}
        {fila.length === 0 && !filaFalhou ? <p className="text-sm text-text-muted">{t("Ninguém esperando resposta.")}</p> : null}
        <ul className="divide-y divide-border rounded-lg border border-border">
          {fila.map((item) => {
            const nome =
              (item.contact_id && nomes.get(item.contact_id)) ||
              (item.canal === "email" ? item.nome : rotuloDoContato(item.contato, t));
            const negocio = item.contact_id ? negocios.get(item.contact_id) : undefined;
            const conta = item.canal === "email" ? (contaDaCaixa.get(item.mailbox_id) ?? "") : "";
            return (
              <li key={item.chave} className="space-y-1 p-3">
                <div className="flex items-baseline justify-between gap-2">
                  <span className="min-w-0 truncate text-sm font-medium">{nome}</span>
                  <span className="shrink-0 text-xs text-text-muted">
                    {t("espera há")} {duracaoCurta(minutosDeEspera(item.desde, agora))}
                  </span>
                </div>
                {item.canal === "email" ? <p className="truncate text-sm">{item.assunto ?? t("(sem assunto)")}</p> : null}
                {item.trecho ? <p className="line-clamp-2 text-xs text-text-muted">{item.trecho}</p> : null}
                <div className="flex flex-wrap items-center gap-x-3 gap-y-1 pt-1 text-xs">
                  <span className="rounded-full border border-border px-2 py-0.5 text-text-muted">
                    {item.canal === "email" ? t("E-mail") : (redes[item.rede] ?? item.rede)}
                  </span>
                  {item.contact_id ? (
                    <Link href={`/app/contacts/${item.contact_id}`} className="underline">{t("Contato")}</Link>
                  ) : (
                    <span className="text-text-muted">{t("Sem contato")}</span>
                  )}
                  {negocio ? <Link href={`/app/leads/${negocio}`} className="underline">{t("Negócio")}</Link> : null}
                  {item.canal === "email" && conta ? (
                    <a href={linkDoGmail(conta, item.gmail_thread_id)} target="_blank" rel="noreferrer" className="underline">
                      {t("Responder no Gmail")}
                    </a>
                  ) : null}
                  {item.canal === "conversa" ? (
                    <Link href={`/app/inbox/${item.conversation_id}`} className="underline">{t("Abrir conversa")}</Link>
                  ) : null}
                </div>
              </li>
            );
          })}
        </ul>
      </section>

      <section className="space-y-2 rounded-lg border border-border p-4">
        <h2 className="text-sm font-semibold">{t("Caixas conectadas")}</h2>
        {caixas.length === 0 ? <p className="text-sm text-text-muted">{t("Nenhuma caixa conectada ainda.")}</p> : null}
        <ul className="divide-y divide-border">
          {caixas.map((c) => (
            <li key={c.id} className="flex flex-wrap items-center justify-between gap-2 py-2 text-sm">
              <span className="min-w-0 break-all">{c.account_email}</span>
              <span className="text-xs text-text-muted">
                {situacao[c.status] ?? c.status}
                {c.last_sync_at ? ` · ${t("lida em")} ${quando(c.last_sync_at, tag)}` : ""}
              </span>
              {c.status === "healthy" && c.last_sync_error ? (
                <span className="w-full text-xs text-text-muted">{t("A última leitura falhou; o CRM tenta de novo em 5 minutos.")}</span>
              ) : null}
            </li>
          ))}
        </ul>
        <div className="flex flex-wrap gap-2 pt-1">
          {!minha || minha.status !== "healthy" ? (
            <a href="/api/v1/gmail/connect" className="inline-flex min-h-11 items-center rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground">
              {minha ? t("Reconectar meu Gmail") : t("Conectar meu Gmail")}
            </a>
          ) : (
            <form action="/api/v1/gmail/disconnect" method="post">
              <button type="submit" className="inline-flex min-h-11 items-center rounded-md border border-border px-4 text-sm">
                {t("Desconectar meu Gmail")}
              </button>
            </form>
          )}
        </div>
        <p className="text-xs text-text-muted">
          {t("O CRM só lê. Nada é enviado, apagado ou marcado no Gmail. Newsletters e avisos automáticos ficam de fora da lista.")}
        </p>
      </section>

      <section className="min-w-0">
        <h2 className="mb-2 text-sm font-semibold">{t("Últimos 30 dias")}</h2>
        {conversas.length === 0 ? <p className="text-sm text-text-muted">{t("Nenhum e-mail ainda.")}</p> : null}
        <ul className="divide-y divide-border rounded-lg border border-border">
          {conversas.map((c) => {
            const conta = contaDaCaixa.get(c.mailbox_id) ?? "";
            const nome = (c.contact_id && nomes.get(c.contact_id)) || c.nomeDaContraparte || c.contraparte || "";
            const negocio = c.contact_id ? negocios.get(c.contact_id) : undefined;
            return (
              <li key={c.chave} className="space-y-1 p-3">
                <div className="flex items-baseline justify-between gap-2">
                  <span className="min-w-0 truncate text-sm font-medium">{nome}</span>
                  <span className="shrink-0 text-xs text-text-muted">{quando(c.ultimaEm, tag)}</span>
                </div>
                <p className="truncate text-sm">
                  {c.assunto ?? t("(sem assunto)")}
                  {c.mensagens > 1 ? <span className="text-text-muted"> ({c.mensagens})</span> : null}
                </p>
                {c.trecho ? <p className="line-clamp-2 text-xs text-text-muted">{c.trecho}</p> : null}
                <div className="flex flex-wrap items-center gap-x-3 gap-y-1 pt-1 text-xs">
                  <span className="text-text-muted">
                    {c.ultimaDirecao === "inbound" ? t("Recebido em") : t("Enviado de")} {conta}
                  </span>
                  {c.contact_id ? (
                    <Link href={`/app/contacts/${c.contact_id}`} className="underline">{t("Contato")}</Link>
                  ) : (
                    <span className="text-text-muted">{t("Sem contato")}</span>
                  )}
                  {negocio ? <Link href={`/app/leads/${negocio}`} className="underline">{t("Negócio")}</Link> : null}
                  {conta ? (
                    <a href={linkDoGmail(conta, c.gmail_thread_id)} target="_blank" rel="noreferrer" className="underline">
                      {t("Abrir no Gmail")}
                    </a>
                  ) : null}
                </div>
              </li>
            );
          })}
        </ul>
      </section>
    </div>
  );
}
