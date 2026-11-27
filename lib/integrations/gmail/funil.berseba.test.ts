import { beforeEach, describe, expect, it, vi } from "vitest";

const atividades: Array<Record<string, unknown>> = [];
vi.mock("@/lib/leads/activity-emitter", () => ({
  emitLeadActivity: vi.fn(async (_db: unknown, input: Record<string, unknown>) => {
    atividades.push(input);
    return { ok: true };
  }),
}));
vi.mock("@/lib/leads/nascimento-do-lead", () => ({
  funilDeEntrada: vi.fn(async () => ({ pipelineId: "pipe", stageId: "entrada" })),
}));
vi.mock("@/lib/contacts/tags-internas", () => ({
  lerTagsInternas: async () => ["interno"],
  ehContatoInterno: (tags: string[], internas: string[]) => tags.some((t) => internas.includes(t)),
}));
vi.mock("@/lib/contacts/tags-da-equipe", () => ({
  lerTagsDaEquipe: async () => [],
  ehContatoDaEquipe: () => false,
}));

const { escritoPeloCliente, levarEmailsAoFunil, nomeDoRemetente } = await import("./funil");

const ORG = "org1";
const NOSSAS = new Set(["socio@empresa.com.br", "socio2@empresa.com.br"]);
const AGORA = new Date("2026-11-27T12:00:00Z");

type Linha = Record<string, unknown>;

/** A fake database with the chains `levarEmailsAoFunil` uses. */
function banco(inicial: { emails: Linha[]; contatos?: Linha[]; leads?: Linha[] }) {
  const t: Record<string, Linha[]> = {
    gmail_messages: inicial.emails,
    contacts: inicial.contatos ?? [],
    crm_leads: inicial.leads ?? [],
  };
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
          const nova = { id: `${tabela}-${++seq}`, is_merged_into: null, is_anonymized: false, ...dados, email_normalized: dados.email };
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
  const rpc = vi.fn(async (_nome: string, a: Record<string, unknown>) => {
    const id = `lead-${++seq}`;
    t.crm_leads!.push({ id, organization_id: a.p_org, contact_id: a.p_contact, status: "open", pipeline_id: a.p_pipeline, stage_id: a.p_stage, title: a.p_title, source: a.p_source });
    return { data: id, error: null };
  });
  return { t, rpc, admin: { from, rpc } as never };
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
    expect(escritoPeloCliente(email({ direction: "outbound", from_email: "socio@empresa.com.br" }) as never, NOSSAS)).toBe(false);
    expect(escritoPeloCliente(email({ from_email: "socio2@empresa.com.br", counterpart_email: "socio2@empresa.com.br" }) as never, NOSSAS)).toBe(false);
  });

  it("the name comes from the header, never an address", () => {
    expect(nomeDoRemetente(email({ from_name: "  Ana   Souza " }) as never)).toBe("Ana Souza");
    expect(nomeDoRemetente(email({ from_name: "ana@cliente.com" }) as never)).toBeNull();
    expect(nomeDoRemetente(email({ from_name: null }) as never)).toBeNull();
  });
});

describe("levarEmailsAoFunil", () => {
  it("a new person who writes in: contact, deal in the entry funnel, the e-mail on its timeline", async () => {
    const b = banco({ emails: [email({ id: "e1" }), email({ id: "e2", direction: "outbound", from_email: "socio@empresa.com.br", sent_at: "2026-11-26T11:00:00Z" })] });
    const r = await levarEmailsAoFunil(b.admin, ORG, NOSSAS, AGORA);

    expect(r).toEqual({ levados: 2, contatosCriados: 1, negociosAbertos: 1, registrosNaTimeline: 2 });
    expect(b.t.contacts![0]).toMatchObject({ name: "Ana Souza", email: "ana@cliente.com", source: "email" });
    expect(b.rpc).toHaveBeenCalledWith("fn_nascer_lead_da_conversa", expect.objectContaining({ p_pipeline: "pipe", p_stage: "entrada", p_title: "Ana Souza", p_source: "email" }));
    expect(atividades.map((a) => a.type)).toEqual(["lead_created", "email_received", "email_sent"]);
    // No message text in the timeline.
    expect(atividades.every((a) => !JSON.stringify(a).includes("Proposta"))).toBe(true);
    expect(b.t.gmail_messages!.every((e) => e.contact_id && e.funil_em)).toBe(true);
  });

  it("an existing open deal only gets the timeline entry", async () => {
    const b = banco({
      emails: [email({ id: "e1", contact_id: "k1" })],
      contatos: [{ id: "k1", organization_id: ORG, email_normalized: "ana@cliente.com", is_merged_into: null, is_anonymized: false }],
      leads: [{ id: "L1", organization_id: ORG, contact_id: "k1", status: "open" }],
    });
    const r = await levarEmailsAoFunil(b.admin, ORG, NOSSAS, AGORA);
    expect(r).toMatchObject({ contatosCriados: 0, negociosAbertos: 0, registrosNaTimeline: 1 });
    expect(atividades[0]).toMatchObject({ leadId: "L1", type: "email_received" });
  });

  it("robots, our own outbound to strangers, internal contacts and old mail never open deals", async () => {
    const b = banco({
      emails: [
        email({ id: "news", is_automated: true, from_email: "news@x.com", counterpart_email: "news@x.com" }),
        email({ id: "out", direction: "outbound", from_email: "socio@empresa.com.br", counterpart_email: "novo@x.com" }),
        email({ id: "int", from_email: "colega@x.com", counterpart_email: "colega@x.com", contact_id: "k9" }),
        email({ id: "velho", from_email: "antigo@x.com", counterpart_email: "antigo@x.com", sent_at: "2026-10-01T10:00:00Z" }),
      ],
      contatos: [{ id: "k9", organization_id: ORG, email_normalized: "colega@x.com", tags: ["interno"], is_merged_into: null, is_anonymized: false }],
    });
    const r = await levarEmailsAoFunil(b.admin, ORG, NOSSAS, AGORA);
    expect(r.negociosAbertos).toBe(0);
    expect(b.rpc).not.toHaveBeenCalled();
    // Only the old person becomes a contact (they wrote in); nobody else does.
    expect(b.t.contacts!.map((c) => c.email_normalized).sort()).toEqual(["antigo@x.com", "colega@x.com"]);
    expect(b.t.gmail_messages!.every((e) => e.funil_em)).toBe(true);
  });

  it("each e-mail is taken once", async () => {
    const b = banco({ emails: [email({ id: "e1" })] });
    await levarEmailsAoFunil(b.admin, ORG, NOSSAS, AGORA);
    const antes = atividades.length;
    const r = await levarEmailsAoFunil(b.admin, ORG, NOSSAS, AGORA);
    expect(r.levados).toBe(0);
    expect(atividades.length).toBe(antes);
  });
});
