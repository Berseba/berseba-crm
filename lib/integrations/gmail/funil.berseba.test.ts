import { beforeEach, describe, expect, it, vi } from "vitest";

const atividades: Array<Record<string, unknown>> = [];
vi.mock("@/lib/leads/activity-emitter", () => ({
  emitLeadActivity: vi.fn(async (_db: unknown, input: Record<string, unknown>) => {
    atividades.push(input);
    return { ok: true };
  }),
  buildLeadActivityRow: (i: Record<string, unknown>) => ({
    organization_id: i.organizationId,
    lead_id: i.leadId,
    contact_id: i.contactId,
    type: i.type,
    source_module: i.sourceModule,
    source_id: i.sourceId,
    reason: i.reason,
    payload: i.payload,
  }),
}));
vi.mock("@/lib/leads/nascimento-do-lead", () => ({
  funilDeEntrada: vi.fn(async (_db: unknown, _org: string, cliente: boolean) =>
    cliente ? { pipelineId: "clientes", stageId: "entrada-clientes" } : { pipelineId: "pipe", stageId: "entrada" },
  ),
}));
vi.mock("@/lib/contacts/regras-de-cliente", () => ({
  lerRegrasDeCliente: async () => ({ pelaAgenda: true, pelaVenda: false, posVendaDias: 0 }),
}));
vi.mock("@/lib/leads/cliente-pela-venda", () => ({
  lerVendaAnterior: async () => null,
  decidirPelaVenda: () => ({ cliente: false, posVenda: false, diasDesdeAVenda: null, motivo: null }),
}));
vi.mock("@/lib/contacts/tags-internas", () => ({
  lerTagsInternas: async () => ["interno"],
  ehContatoInterno: (tags: string[], internas: string[]) => tags.some((t) => internas.includes(t)),
}));
vi.mock("@/lib/contacts/tags-da-equipe", () => ({
  lerTagsDaEquipe: async () => [],
  ehContatoDaEquipe: () => false,
}));
vi.mock("@/lib/logger", () => ({ logger: { warn: vi.fn(), info: vi.fn() } }));

const { escritoPeloCliente, levarEmailsAoFunil, nomeDoRemetente, TENTATIVAS } = await import("./funil");

const ORG = "org1";
const NOSSAS = new Set(["socio@empresa.com.br", "socio2@empresa.com.br"]);
const AGORA = new Date("2026-11-27T12:00:00Z");

type Linha = Record<string, unknown>;

const contato = (over: Linha): Linha => ({
  organization_id: ORG,
  name: null,
  display_name: null,
  phone_number: null,
  first_service_at: null,
  is_blocked: false,
  is_personal: false,
  tags: [],
  is_merged_into: null,
  is_anonymized: false,
  ...over,
});

/** A fake database with the chains `levarEmailsAoFunil` uses. */
function banco(inicial: { emails: Linha[]; contatos?: Linha[]; leads?: Linha[] }, opcoes: { rpcFalha?: boolean } = {}) {
  const t: Record<string, Linha[]> = {
    gmail_messages: inicial.emails,
    contacts: inicial.contatos ?? [],
    crm_leads: inicial.leads ?? [],
    crm_lead_activities: [],
  };
  const eventos: Linha[] = [];
  let seq = 0;
  const from = (tabela: string) => {
    const filtros: Array<(l: Linha) => boolean> = [];
    let acao: "select" | "update" | "insert" = "select";
    let dados: Linha = {};
    let um = false;
    const q = {
      select: () => q,
      eq: (c: string, v: unknown) => (filtros.push((l) => l[c] === v), q),
      is: (c: string, v: unknown) => (filtros.push((l) => (l[c] ?? null) === v), q),
      or: () => q,
      order: () => q,
      limit: () => q,
      maybeSingle: () => ((um = true), q),
      update: (d: Linha) => ((acao = "update"), (dados = d), q),
      insert: (d: Linha) => ((acao = "insert"), (dados = d), q),
      then: (ok: (r: { data: unknown; error: null }) => unknown) => {
        const linhas = t[tabela]!;
        if (acao === "insert") {
          const nova = tabela === "contacts" ? contato({ id: `k-${++seq}`, ...dados, email_normalized: dados.email }) : { id: `${tabela}-${++seq}`, ...dados };
          linhas.push(nova);
          return Promise.resolve(ok({ data: { id: nova.id }, error: null }));
        }
        const casam = linhas.filter((l) => filtros.every((f) => f(l)));
        if (acao === "update") casam.forEach((l) => Object.assign(l, dados));
        return Promise.resolve(ok({ data: um ? (casam[0] ?? null) : casam, error: null }));
      },
    };
    return q;
  };
  const rpc = vi.fn(async (nome: string, a: Record<string, unknown>) => {
    if (nome === "emit_event") {
      eventos.push(a);
      return { data: null, error: null };
    }
    if (opcoes.rpcFalha) return { data: null, error: { message: "down" } };
    const id = `lead-${++seq}`;
    t.crm_leads!.push({ id, organization_id: a.p_org, contact_id: a.p_contact, status: "open", pipeline_id: a.p_pipeline, stage_id: a.p_stage, title: a.p_title, source: a.p_source });
    return { data: id, error: null };
  });
  return { t, rpc, eventos, admin: { from, rpc } as never };
}

const email = (over: Linha): Linha => ({
  id: `e${Math.random()}`,
  organization_id: ORG,
  mailbox_id: "cx1",
  direction: "inbound",
  from_email: "ana@cliente.com",
  from_name: "Ana Souza",
  counterpart_email: "ana@cliente.com",
  contact_id: null,
  is_automated: false,
  sent_at: "2026-11-26T10:00:00Z",
  funil_em: null,
  funil_tentativas: 0,
  ...over,
});

beforeEach(() => {
  atividades.length = 0;
});

describe("pure parts", () => {
  it("a person wrote it: not a robot, not a no-reply, not us", () => {
    expect(escritoPeloCliente(email({}) as never, NOSSAS)).toBe(true);
    expect(escritoPeloCliente(email({ is_automated: true }) as never, NOSSAS)).toBe(false);
    expect(escritoPeloCliente(email({ from_email: "no-reply@x.com", counterpart_email: "no-reply@x.com" }) as never, NOSSAS)).toBe(false);
    expect(escritoPeloCliente(email({ from_email: "comments-noreply@docs.google.com", counterpart_email: "comments-noreply@docs.google.com" }) as never, NOSSAS)).toBe(false);
    expect(escritoPeloCliente(email({ direction: "outbound", from_email: "socio@empresa.com.br" }) as never, NOSSAS)).toBe(false);
    expect(escritoPeloCliente(email({ from_email: "socio2@empresa.com.br", counterpart_email: "socio2@empresa.com.br" }) as never, NOSSAS)).toBe(false);
  });

  it("the name comes from the header, never an address", () => {
    expect(nomeDoRemetente(email({ from_name: "  Ana   Souza " }) as never)).toBe("Ana Souza");
    expect(nomeDoRemetente(email({ from_name: "ana@cliente.com" }) as never)).toBeNull();
  });
});

describe("levarEmailsAoFunil", () => {
  it("a new person who writes in: contact, deal in the entry funnel, lead.created, the e-mails on the timeline at their own time", async () => {
    const b = banco({ emails: [email({ id: "e1" }), email({ id: "e2", direction: "outbound", from_email: "socio@empresa.com.br", sent_at: "2026-11-26T11:00:00Z" })] });
    const r = await levarEmailsAoFunil(b.admin, ORG, NOSSAS, AGORA);

    expect(r).toEqual({ levados: 2, contatosCriados: 1, negociosAbertos: 1, registrosNaTimeline: 2, adiados: 0 });
    expect(b.t.contacts![0]).toMatchObject({ name: "Ana Souza", email: "ana@cliente.com", source: "email" });
    expect(b.rpc).toHaveBeenCalledWith("fn_nascer_lead_da_conversa", expect.objectContaining({ p_pipeline: "pipe", p_title: "Ana Souza", p_source: "email" }));
    expect(b.eventos).toEqual([expect.objectContaining({ p_event_type: "lead.created", p_organization_id: ORG })]);
    expect(atividades.map((a) => a.type)).toEqual(["lead_created"]);
    expect(b.t.crm_lead_activities!.map((a) => [a.type, a.performed_at])).toEqual([
      ["email_received", "2026-11-26T10:00:00.000Z"],
      ["email_sent", "2026-11-26T11:00:00.000Z"],
    ]);
    expect(JSON.stringify(b.t.crm_lead_activities)).not.toContain("Proposta");
    expect(b.t.gmail_messages!.every((e) => e.contact_id && e.funil_em)).toBe(true);
  });

  it("a known client goes to the client funnel; the title is the contact's label", async () => {
    const b = banco({
      emails: [email({ id: "e1", contact_id: "k1" })],
      contatos: [contato({ id: "k1", name: "Ana Cliente", first_service_at: "2026-01-01T00:00:00Z", email_normalized: "ana@cliente.com" })],
    });
    await levarEmailsAoFunil(b.admin, ORG, NOSSAS, AGORA);
    expect(b.rpc).toHaveBeenCalledWith("fn_nascer_lead_da_conversa", expect.objectContaining({ p_pipeline: "clientes", p_title: "Ana Cliente" }));
  });

  it("an e-mail on a merged contact follows the winner, whose open deal gets the line", async () => {
    const b = banco({
      emails: [email({ id: "e1", contact_id: "perdedor" })],
      contatos: [contato({ id: "perdedor", is_merged_into: "vencedor" }), contato({ id: "vencedor" })],
      leads: [{ id: "L1", organization_id: ORG, contact_id: "vencedor", status: "open" }],
    });
    const r = await levarEmailsAoFunil(b.admin, ORG, NOSSAS, AGORA);
    expect(r.negociosAbertos).toBe(0);
    expect(b.t.crm_lead_activities![0]).toMatchObject({ lead_id: "L1", contact_id: "vencedor" });
    expect(b.t.gmail_messages![0]).toMatchObject({ contact_id: "vencedor" });
  });

  it("robots, our own outbound to strangers, internal and anonymized contacts and old mail never open deals", async () => {
    const b = banco({
      emails: [
        email({ id: "news", is_automated: true, from_email: "news@x.com", counterpart_email: "news@x.com" }),
        email({ id: "out", direction: "outbound", from_email: "socio@empresa.com.br", counterpart_email: "novo@x.com" }),
        email({ id: "int", from_email: "colega@x.com", counterpart_email: "colega@x.com", contact_id: "k9" }),
        email({ id: "anon", from_email: "sumiu@x.com", counterpart_email: "sumiu@x.com", contact_id: "k8" }),
        email({ id: "velho", from_email: "antigo@x.com", counterpart_email: "antigo@x.com", sent_at: "2026-10-01T10:00:00Z" }),
      ],
      contatos: [contato({ id: "k9", tags: ["interno"], email_normalized: "colega@x.com" }), contato({ id: "k8", is_anonymized: true })],
    });
    const r = await levarEmailsAoFunil(b.admin, ORG, NOSSAS, AGORA);
    expect(r.negociosAbertos).toBe(0);
    expect(b.rpc).not.toHaveBeenCalled();
    expect(b.t.gmail_messages!.every((e) => e.funil_em)).toBe(true);
  });

  it("a failed write leaves the e-mail for the next run, and is given up after the limit", async () => {
    const b = banco({ emails: [email({ id: "e1" })] }, { rpcFalha: true });
    for (let i = 1; i < TENTATIVAS; i++) {
      const r = await levarEmailsAoFunil(b.admin, ORG, NOSSAS, AGORA);
      expect(r.adiados).toBe(1);
      expect(b.t.gmail_messages![0]).toMatchObject({ funil_em: null, funil_tentativas: i });
    }
    const r = await levarEmailsAoFunil(b.admin, ORG, NOSSAS, AGORA);
    expect(r.levados).toBe(1);
    expect(b.t.gmail_messages![0]!.funil_em).not.toBeNull();
  });

  it("each e-mail gives one timeline line, ever", async () => {
    const b = banco({ emails: [email({ id: "e1" })] });
    await levarEmailsAoFunil(b.admin, ORG, NOSSAS, AGORA);
    b.t.gmail_messages![0]!.funil_em = null; // as if the run was killed before the mark
    await levarEmailsAoFunil(b.admin, ORG, NOSSAS, AGORA);
    expect(b.t.crm_lead_activities!.filter((a) => a.type === "email_received")).toHaveLength(1);
  });

  it("stops at the deadline", async () => {
    const b = banco({ emails: [email({ id: "e1" }), email({ id: "e2" })] });
    const r = await levarEmailsAoFunil(b.admin, ORG, NOSSAS, AGORA, 0, () => 1);
    expect(r.levados).toBe(0);
  });
});
