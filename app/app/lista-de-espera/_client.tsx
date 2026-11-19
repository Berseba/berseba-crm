"use client";
/**
 * Berseba (migration 9007): the avec salon's waitlist screen — the switch and deadlines, the
 * queue in calling order, and a new entry. Same building blocks as upstream's waitlist screen
 * (`app/app/agenda/lista-de-espera/_client.tsx`).
 */
import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { showApiError } from "@/components/feedback/ApiErrorToast";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { useT } from "@/hooks/i18n/useT";
import { apiClient } from "@/lib/api/client";
import { nomeDoContato } from "@/lib/contacts/rotulo-do-contato";

type Config = {
  ativa: boolean;
  prazo_maximo_minutos: number;
  margem_antes_minutos: number;
  prazo_minimo_minutos: number;
};

type Oferta = { data: string; inicio: string; profissional_nome: string | null } | null;

type Inscricao = {
  id: string;
  contato: string | null;
  pedido: { servico: string; comprimento: string | null; profissional: string | null };
  data_de: string;
  data_ate: string;
  depois_de: string | null;
  ate: string | null;
  substitui_data: string | null;
  status: "waiting" | "offered" | "booked" | "cancelled" | "expired";
  oferta: Oferta;
  oferta_expira_em: string | null;
  observacoes: string | null;
  created_by_kind: "user" | "ai";
  resultado: { data?: string; inicio?: string } | null;
};

type Servico = {
  id: string;
  nome: string;
  precisa_comprimento: boolean;
  profissionais: Array<{ id: string; nome: string }>;
};

type Estado = {
  config: Config | null;
  fila: Inscricao[];
  encerradas: Inscricao[];
  servicos: Servico[];
  profissionais: Record<string, string>;
};

type Contato = { id: string; name: string | null; display_name: string | null; phone_number: string | null };

const CHAVE = ["avec", "lista-de-espera"];
const SELECT = "min-h-11 w-full rounded-md border border-border bg-background px-2 text-sm";

const dataBr = (d: string | null | undefined) => (d ? `${d.slice(8, 10)}/${d.slice(5, 7)}` : "");
const horaDe = (iso: string) =>
  new Intl.DateTimeFormat("pt-BR", { timeZone: "America/Sao_Paulo", hour: "2-digit", minute: "2-digit" }).format(
    new Date(iso),
  );

function Prazos({ config }: { config: Config | null }) {
  const t = useT();
  const qc = useQueryClient();
  const [ativa, setAtiva] = useState(config?.ativa ?? false);
  // Suggested values when the organization never chose: 2 h to answer, no offer 3 h before, 30 min minimum.
  const [resposta, setResposta] = useState(String((config?.prazo_maximo_minutos ?? 120) / 60));
  const [margem, setMargem] = useState(String((config?.margem_antes_minutos ?? 180) / 60));
  const [minimo, setMinimo] = useState(String(config?.prazo_minimo_minutos ?? 30));

  const salvar = useMutation({
    mutationFn: () =>
      apiClient.patch("/api/v1/avec/lista-de-espera", {
        ativa,
        prazo_maximo_minutos: Math.round(Number(resposta) * 60),
        margem_antes_minutos: Math.round(Number(margem) * 60),
        prazo_minimo_minutos: Math.round(Number(minimo)),
      }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: CHAVE }),
    onError: (erro) => showApiError(erro),
  });

  return (
    <section className="max-w-xl space-y-3 rounded-lg border border-border p-4">
      <h2 className="text-sm font-semibold">{t("Configuração")}</h2>
      <div className="flex items-center gap-2">
        <Switch id="espera_ativa" checked={ativa} onCheckedChange={setAtiva} />
        <Label htmlFor="espera_ativa">{t("Lista de espera ligada")}</Label>
      </div>
      <div className="grid gap-3 sm:grid-cols-3">
        <div className="space-y-1">
          <Label htmlFor="espera_resposta">{t("Prazo para responder (horas)")}</Label>
          <Input id="espera_resposta" type="number" min={0.5} max={24} step={0.5} value={resposta} onChange={(e) => setResposta(e.target.value)} />
        </div>
        <div className="space-y-1">
          <Label htmlFor="espera_margem">{t("Não oferecer se faltar menos de (horas)")}</Label>
          <Input id="espera_margem" type="number" min={0} max={24} step={0.5} value={margem} onChange={(e) => setMargem(e.target.value)} />
        </div>
        <div className="space-y-1">
          <Label htmlFor="espera_minimo">{t("Tempo mínimo para responder (minutos)")}</Label>
          <Input id="espera_minimo" type="number" min={1} max={1440} value={minimo} onChange={(e) => setMinimo(e.target.value)} />
        </div>
      </div>
      <p className="text-sm text-text-muted">
        {t("O prazo nunca passa do horário da vaga menos a folga. As mensagens só saem na janela de envio do número.")}
      </p>
      <Button onClick={() => salvar.mutate()} disabled={salvar.isPending}>
        {salvar.isPending ? t("Salvando…") : t("Salvar")}
      </Button>
    </section>
  );
}

function NovaInscricao({ servicos }: { servicos: Servico[] }) {
  const t = useT();
  const qc = useQueryClient();
  const [busca, setBusca] = useState("");
  const [contatoId, setContatoId] = useState("");
  const [servicoId, setServicoId] = useState("");
  const [comprimento, setComprimento] = useState("");
  const [profissional, setProfissional] = useState("");
  const [dataDe, setDataDe] = useState("");
  const [dataAte, setDataAte] = useState("");
  const [depoisDe, setDepoisDe] = useState("");
  const [ate, setAte] = useState("");
  const [substitui, setSubstitui] = useState("");
  const [observacoes, setObservacoes] = useState("");
  const servico = servicos.find((s) => s.id === servicoId);

  const { data: contatos } = useQuery({
    queryKey: ["contatos", "lista-de-espera-do-salao", busca],
    enabled: busca.trim().length >= 2,
    queryFn: async () =>
      (await apiClient.get<{ data: Contato[] }>(`/api/v1/contacts?search=${encodeURIComponent(busca.trim())}&limit=8`)).data,
  });

  const adicionar = useMutation({
    mutationFn: () =>
      apiClient.post("/api/v1/avec/lista-de-espera", {
        contact_id: contatoId,
        servico: servicoId,
        comprimento: comprimento || null,
        profissional: profissional || null,
        data_de: dataDe,
        data_ate: dataAte || dataDe,
        depois_de: depoisDe || null,
        ate: ate || null,
        substitui_data: substitui || null,
        observacoes: observacoes || null,
      }),
    onSuccess: () => {
      setBusca("");
      setContatoId("");
      setServicoId("");
      setComprimento("");
      setProfissional("");
      setDataDe("");
      setDataAte("");
      setDepoisDe("");
      setAte("");
      setSubstitui("");
      setObservacoes("");
      void qc.invalidateQueries({ queryKey: CHAVE });
    },
    onError: (erro) => showApiError(erro),
  });

  const faltaAlgo = !contatoId || !servicoId || !dataDe || (servico?.precisa_comprimento && !comprimento);

  return (
    <section className="max-w-xl space-y-3 rounded-lg border border-border p-4">
      <h2 className="text-sm font-semibold">{t("Adicionar à lista")}</h2>
      <div className="space-y-1">
        <Label htmlFor="espera_busca">{t("Cliente")}</Label>
        <Input
          id="espera_busca"
          value={busca}
          onChange={(e) => {
            setBusca(e.target.value);
            setContatoId("");
          }}
          placeholder={t("Nome ou telefone")}
        />
        {(contatos ?? []).length > 0 ? (
          <select aria-label={t("Cliente")} className={SELECT} value={contatoId} onChange={(e) => setContatoId(e.target.value)}>
            <option value="">{t("Escolha a cliente")}</option>
            {(contatos ?? []).map((c) => (
              <option key={c.id} value={c.id}>
                {nomeDoContato(c) ?? c.phone_number ?? t("Cliente")}
              </option>
            ))}
          </select>
        ) : null}
      </div>
      <div className="grid gap-3 sm:grid-cols-2">
        <div className="space-y-1">
          <Label htmlFor="espera_servico">{t("Serviço")}</Label>
          <select
            id="espera_servico"
            className={SELECT}
            value={servicoId}
            onChange={(e) => {
              setServicoId(e.target.value);
              setProfissional("");
              setComprimento("");
            }}
          >
            <option value="">{t("Escolha o serviço")}</option>
            {servicos.map((s) => (
              <option key={s.id} value={s.id}>
                {s.nome}
              </option>
            ))}
          </select>
        </div>
        <div className="space-y-1">
          <Label htmlFor="espera_profissional">{t("Profissional")}</Label>
          <select id="espera_profissional" className={SELECT} value={profissional} onChange={(e) => setProfissional(e.target.value)}>
            <option value="">{t("Qualquer profissional")}</option>
            {(servico?.profissionais ?? []).map((p) => (
              <option key={p.id} value={p.id}>
                {p.nome}
              </option>
            ))}
          </select>
        </div>
        {servico?.precisa_comprimento ? (
          <div className="space-y-1">
            <Label htmlFor="espera_comprimento">{t("Comprimento do cabelo")}</Label>
            <select id="espera_comprimento" className={SELECT} value={comprimento} onChange={(e) => setComprimento(e.target.value)}>
              <option value="">{t("Escolha o comprimento")}</option>
              <option value="curto">{t("Curto")}</option>
              <option value="medio">{t("Médio")}</option>
              <option value="longo">{t("Longo")}</option>
              <option value="extra_longo">{t("Extra longo")}</option>
            </select>
          </div>
        ) : null}
        <div className="space-y-1">
          <Label htmlFor="espera_data_de">{t("A partir do dia")}</Label>
          <Input id="espera_data_de" type="date" value={dataDe} onChange={(e) => setDataDe(e.target.value)} />
        </div>
        <div className="space-y-1">
          <Label htmlFor="espera_data_ate">{t("Até o dia")}</Label>
          <Input id="espera_data_ate" type="date" value={dataAte} onChange={(e) => setDataAte(e.target.value)} />
        </div>
        <div className="space-y-1">
          <Label htmlFor="espera_depois_de">{t("Começar a partir de")}</Label>
          <Input id="espera_depois_de" type="time" value={depoisDe} onChange={(e) => setDepoisDe(e.target.value)} />
        </div>
        <div className="space-y-1">
          <Label htmlFor="espera_ate">{t("Começar até")}</Label>
          <Input id="espera_ate" type="time" value={ate} onChange={(e) => setAte(e.target.value)} />
        </div>
        <div className="space-y-1">
          <Label htmlFor="espera_substitui">{t("Já tem horário no dia (para adiantar)")}</Label>
          <Input id="espera_substitui" type="date" value={substitui} onChange={(e) => setSubstitui(e.target.value)} />
        </div>
      </div>
      <div className="space-y-1">
        <Label htmlFor="espera_obs">{t("Observação")}</Label>
        <Input id="espera_obs" maxLength={500} value={observacoes} onChange={(e) => setObservacoes(e.target.value)} />
      </div>
      <Button onClick={() => adicionar.mutate()} disabled={Boolean(faltaAlgo) || adicionar.isPending}>
        {t("Adicionar")}
      </Button>
    </section>
  );
}

function Linha({
  inscricao,
  posicao,
  estado,
  podeOperar,
  agir,
}: {
  inscricao: Inscricao;
  posicao: number | null;
  estado: Estado;
  podeOperar: boolean;
  agir?: (acao: "subir" | "descer" | "remover" | "procurar") => void;
}) {
  const t = useT();
  const servico = estado.servicos.find((s) => s.id === inscricao.pedido.servico)?.nome ?? inscricao.pedido.servico;
  const profissional = inscricao.pedido.profissional
    ? (estado.profissionais[inscricao.pedido.profissional] ?? inscricao.pedido.profissional)
    : t("qualquer profissional");
  const dias =
    inscricao.data_de === inscricao.data_ate
      ? dataBr(inscricao.data_de)
      : `${dataBr(inscricao.data_de)} a ${dataBr(inscricao.data_ate)}`;
  const horario =
    inscricao.depois_de || inscricao.ate
      ? `${inscricao.depois_de?.slice(0, 5) ?? ""}–${inscricao.ate?.slice(0, 5) ?? ""}`
      : t("qualquer hora");
  const situacao = (() => {
    switch (inscricao.status) {
      case "offered":
        return `${t("Oferta enviada")}: ${dataBr(inscricao.oferta?.data)} ${inscricao.oferta?.inicio ?? ""} · ${t("até")} ${inscricao.oferta_expira_em ? horaDe(inscricao.oferta_expira_em) : ""}`;
      case "booked":
        return `${t("Encaixada")} ${dataBr(inscricao.resultado?.data)} ${inscricao.resultado?.inicio ?? ""}`;
      case "cancelled":
        return t("Saiu da lista");
      case "expired":
        return t("Venceu");
      default:
        return t("Aguardando");
    }
  })();
  const cor =
    inscricao.status === "offered"
      ? "bg-amber-500/15 text-amber-700 dark:text-amber-300"
      : inscricao.status === "booked"
        ? "bg-emerald-500/15 text-emerald-700 dark:text-emerald-300"
        : "bg-muted text-text-muted";

  return (
    <li className="flex flex-wrap items-center justify-between gap-2 p-3">
      <div className="min-w-0">
        <p className="truncate text-sm font-medium">
          {posicao !== null ? `${posicao}. ` : ""}
          {inscricao.contato ?? t("Cliente")}
          {inscricao.created_by_kind === "ai" ? <span className="ml-2 text-xs text-text-muted">{t("pela Maya")}</span> : null}
        </p>
        <p className="text-sm text-text-muted">
          {servico} · {profissional} · {dias} · {horario}
          {inscricao.substitui_data ? ` · ${t("adiantar o de")} ${dataBr(inscricao.substitui_data)}` : ""}
        </p>
        {inscricao.observacoes ? <p className="text-xs text-text-muted">{inscricao.observacoes}</p> : null}
        <span className={`mt-1 inline-block rounded-full px-2 py-0.5 text-xs font-medium ${cor}`}>{situacao}</span>
      </div>
      {podeOperar && agir ? (
        <div className="flex flex-wrap gap-2">
          <Button size="sm" variant="ghost" aria-label={t("Subir")} onClick={() => agir("subir")}>
            ↑
          </Button>
          <Button size="sm" variant="ghost" aria-label={t("Descer")} onClick={() => agir("descer")}>
            ↓
          </Button>
          {inscricao.status === "waiting" ? (
            <Button size="sm" variant="outline" onClick={() => agir("procurar")}>
              {t("Procurar vaga agora")}
            </Button>
          ) : null}
          <Button size="sm" variant="ghost" onClick={() => agir("remover")}>
            {t("Remover")}
          </Button>
        </div>
      ) : null}
    </li>
  );
}

export function ListaDeEsperaDoSalao({ podeConfigurar, podeOperar }: { podeConfigurar: boolean; podeOperar: boolean }) {
  const t = useT();
  const qc = useQueryClient();
  const [mostrarEncerradas, setMostrarEncerradas] = useState(false);

  const { data, isLoading } = useQuery({
    queryKey: CHAVE,
    queryFn: async () => (await apiClient.get<{ data: Estado }>("/api/v1/avec/lista-de-espera")).data,
    refetchInterval: 60_000,
  });

  const agir = useMutation({
    mutationFn: ({ id, acao }: { id: string; acao: "subir" | "descer" | "remover" | "procurar" }) =>
      apiClient.patch(`/api/v1/avec/lista-de-espera/${id}`, { acao }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: CHAVE }),
    onError: (erro) => showApiError(erro),
  });

  if (isLoading || !data) return <p className="text-sm text-text-muted">{t("Carregando…")}</p>;

  return (
    <div className="flex flex-col gap-4">
      {podeConfigurar ? <Prazos key={JSON.stringify(data.config)} config={data.config} /> : null}
      {!data.config?.ativa ? (
        <p className="text-sm text-text-muted">
          {t("A lista de espera está desligada: ninguém recebe oferta de vaga até ela ser ligada.")}
        </p>
      ) : null}
      <section className="space-y-2">
        <h2 className="text-sm font-semibold">{t("Fila")}</h2>
        {data.fila.length === 0 ? (
          <p className="text-sm text-text-muted">{t("Ninguém na lista de espera.")}</p>
        ) : (
          <ul className="divide-y divide-border rounded-lg border border-border">
            {data.fila.map((inscricao, i) => (
              <Linha
                key={inscricao.id}
                inscricao={inscricao}
                posicao={i + 1}
                estado={data}
                podeOperar={podeOperar}
                agir={(acao) => agir.mutate({ id: inscricao.id, acao })}
              />
            ))}
          </ul>
        )}
      </section>
      {podeOperar ? <NovaInscricao servicos={data.servicos} /> : null}
      {data.encerradas.length > 0 ? (
        <section className="space-y-2">
          <Button size="sm" variant="ghost" onClick={() => setMostrarEncerradas(!mostrarEncerradas)}>
            {mostrarEncerradas ? t("Esconder encerradas") : t("Mostrar encerradas")}
          </Button>
          {mostrarEncerradas ? (
            <ul className="divide-y divide-border rounded-lg border border-border">
              {data.encerradas.map((inscricao) => (
                <Linha key={inscricao.id} inscricao={inscricao} posicao={null} estado={data} podeOperar={false} />
              ))}
            </ul>
          ) : null}
        </section>
      ) : null}
    </div>
  );
}
