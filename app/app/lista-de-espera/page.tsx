import { notFound, redirect } from "next/navigation";

import { requireAuth, resolveActiveOrg } from "@/lib/auth/server";
import { ROLE_RANK } from "@/lib/auth/types";
import { traduzir } from "@/lib/i18n/dicionario";
import { salaoDaOrganizacao } from "@/lib/integrations/avec/lista-de-espera-supabase";

import { ListaDeEsperaDoSalao } from "./_client";

export const dynamic = "force-dynamic";

/**
 * Berseba (migration 9007): the avec salon's waitlist. Only organizations that use avec have
 * this page; the team sees the queue, adds and orders clients, and the manager turns it on.
 */
export default async function Page() {
  const user = await requireAuth();
  const org = await resolveActiveOrg(user);
  if (!org) redirect("/app");
  if (!salaoDaOrganizacao(org.orgId)) notFound();

  const t = (texto: string) => traduzir(texto, user.idioma);

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-4">
      <div>
        <h1 className="text-xl font-semibold">{t("Lista de espera do salão")}</h1>
        <p className="text-sm text-text-muted">
          {t("Quando abre um horário no avec, a vaga é oferecida no WhatsApp a uma cliente por vez, na ordem da lista.")}
        </p>
      </div>
      <ListaDeEsperaDoSalao
        podeConfigurar={ROLE_RANK[org.role] >= ROLE_RANK.manager}
        podeOperar={ROLE_RANK[org.role] >= ROLE_RANK.agent}
      />
    </div>
  );
}
