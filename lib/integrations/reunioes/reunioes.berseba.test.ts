import { describe, expect, it, vi } from "vitest";

const ORG = "11111111-1111-4111-8111-111111111111";
vi.mock("@/lib/env", () => ({ env: { MEETING_DETECTION_ORG_IDS: ` ${ORG.toUpperCase()}, lixo` } }));

const { deteccaoLigada, falaDeReuniao, lerResposta, orgsComDeteccao, semCitacao, trechoDa } = await import("./deteccao");
const { ehRecusaDeOrcamento, escolherCandidatas, linhaDaProposta, rodadaDeReunioes } = await import("./varredura");

const AGORA = new Date("2026-11-27T12:00:00Z");

describe("config", () => {
  it("only listed organizations, fails closed", () => {
    expect(deteccaoLigada(ORG)).toBe(true);
    expect(deteccaoLigada("99999999-9999-4999-8999-999999999999")).toBe(false);
    expect(orgsComDeteccao("")).toEqual(new Set());
  });
});

describe("falaDeReuniao", () => {
  it("keeps messages that talk about meeting, drops the rest", () => {
    expect(falaDeReuniao("Podemos marcar uma call quinta às 10h?")).toBe(true);
    expect(falaDeReuniao("Confirmado para amanhã 14:30")).toBe(true);
    expect(falaDeReuniao("Segue o boleto em anexo, obrigado")).toBe(false);
    expect(falaDeReuniao(null)).toBe(false);
  });
});

describe("lerResposta", () => {
  it("a request with a valid future time", () => {
    expect(lerResposta({ intencao: "pede", inicio: "2026-12-03T10:00:00-03:00", duracao_minutos: 45, assunto: " Proposta " }, AGORA)).toEqual({
      intent: "pede",
      starts_at: "2026-12-03T13:00:00.000Z",
      duration_minutes: 45,
      title: "Proposta",
    });
  });

  it("drops a past, far or invented time and an absurd duration, keeps the proposal", () => {
    expect(lerResposta({ intencao: "confirma", inicio: "2026-11-01T10:00:00Z", duracao_minutos: 2 }, AGORA)).toMatchObject({
      intent: "confirma",
      starts_at: null,
      duration_minutes: null,
    });
    expect(lerResposta({ intencao: "pede", inicio: "2027-12-01T10:00:00Z" }, AGORA)!.starts_at).toBeNull();
    expect(lerResposta({ intencao: "pede", inicio: "quinta" }, AGORA)!.starts_at).toBeNull();
    // Without an offset it would be read in the server's zone: dropped.
    expect(lerResposta({ intencao: "pede", inicio: "2026-12-03T10:00:00" }, AGORA)!.starts_at).toBeNull();
    expect(lerResposta({ intencao: "pede", inicio: "2026-12-03T13:00:00Z" }, AGORA)!.starts_at).toBe("2026-12-03T13:00:00.000Z");
  });

  it("'nenhuma' keeps nothing; an unreadable answer is null (retried)", () => {
    expect(lerResposta({ intencao: "nenhuma", inicio: "2026-12-03T10:00:00Z", assunto: "x" }, AGORA)).toEqual({
      intent: "nenhuma",
      starts_at: null,
      duration_minutes: null,
      title: null,
    });
    expect(lerResposta(null, AGORA)).toBeNull();
    expect(lerResposta({ intencao: "talvez" }, AGORA)).toBeNull();
  });
});

describe("semCitacao", () => {
  it("drops the quoted thread under the client's words", () => {
    expect(
      semCitacao("Confirmado!\n\nEm qua., 26 de nov. de 2026 às 10:00, Matheus <m@x.com> escreveu:\n> Pode quinta 10h?"),
    ).toBe("Confirmado!");
    expect(semCitacao("Ok\n> antiga\nAté")).toBe("Ok\nAté");
    expect(semCitacao("Sure\nOn Wed, Nov 26, 2026 at 10:00 AM Ana wrote:\nold")).toBe("Sure");
    expect(semCitacao("Pode ser\n\nDe: Matheus <m@x.com>\nEnviado: quarta\nquinta 10h?")).toBe("Pode ser");
  });
});

describe("escolherCandidatas and linhaDaProposta", () => {
  const c = (id: string, texto: string, sent_at: string) => ({
    source: "whatsapp" as const,
    source_id: id,
    contact_id: "k1",
    owner_user_id: null,
    texto,
    sent_at,
  });

  it("new, about meeting, oldest first, capped", () => {
    const todas = [c("3", "reunião sexta?", "2026-11-27T10:00:00Z"), c("1", "call amanhã?", "2026-11-26T10:00:00Z"), c("2", "obrigado", "2026-11-26T11:00:00Z"), c("4", "marcar visita", "2026-11-25T10:00:00Z")];
    expect(escolherCandidatas(todas, new Set(["whatsapp:4"]), 1).map((x) => x.source_id)).toEqual(["1"]);
    expect(escolherCandidatas(todas, new Set(), 10).map((x) => x.source_id)).toEqual(["4", "1", "3"]);
  });

  it("'nenhuma' rows keep no text", () => {
    const linha = linhaDaProposta(ORG, c("1", "call amanhã?", "2026-11-26T10:00:00Z"), {
      intent: "nenhuma",
      starts_at: null,
      duration_minutes: null,
      title: null,
    });
    expect(linha).toMatchObject({ status: "nenhuma", excerpt: null, title: null });
    expect(trechoDa("a\n\n  b ".repeat(300)).length).toBe(500);
  });
});

/** A fake database with only the chains `rodadaDeReunioes` uses. */
function bancoFalso(emails: Array<Record<string, unknown>>, mensagens: Array<Record<string, unknown>>) {
  const propostas: Array<Record<string, unknown>> = [];
  const de = (tabela: string) => {
    const filtros: Array<(l: Record<string, unknown>) => boolean> = [];
    let novas: Array<Record<string, unknown>> | null = null;
    let apagar = false;
    const q = {
      select: () => q,
      eq: (c: string, v: unknown) => (c.includes(".") ? q : (filtros.push((l) => l[c] === v), q)),
      in: (c: string, vs: unknown[]) => (filtros.push((l) => vs.includes(l[c])), q),
      is: () => q,
      gte: () => q,
      lt: () => q,
      delete: () => ((apagar = true), q),
      order: () => q,
      limit: () => q,
      upsert: (l: Record<string, unknown>) => ((novas = [l]), q),
      then: (ok: (r: { data: unknown; error: null }) => unknown) => {
        if (apagar) return Promise.resolve(ok({ data: null, error: null }));
        if (novas) {
          propostas.push(...novas);
          return Promise.resolve(ok({ data: null, error: null }));
        }
        const base = tabela === "gmail_messages" ? emails : tabela === "messages" ? mensagens : propostas;
        return Promise.resolve(ok({ data: base.filter((l) => filtros.every((f) => f(l))), error: null }));
      },
    };
    return q;
  };
  return { propostas, admin: { from: de } as never };
}

describe("rodadaDeReunioes", () => {
  it("sends only meeting-talk to the model, stores one row per answer, never twice", async () => {
    const banco = bancoFalso(
      [
        { id: "e1", organization_id: ORG, direction: "inbound", is_automated: false, contact_id: "k1", from_email: "ana@x.com", counterpart_email: "ana@x.com", subject: "Proposta", body_text: "Podemos conversar quinta às 10h?", snippet: null, sent_at: "2026-11-27T09:00:00Z", gmail_mailboxes: { user_id: "u1" } },
        { id: "e2", organization_id: ORG, direction: "inbound", is_automated: false, contact_id: "k2", from_email: "b@x.com", counterpart_email: "b@x.com", subject: "Boleto", body_text: "Segue o boleto", snippet: null, sent_at: "2026-11-27T09:00:00Z", gmail_mailboxes: { user_id: "u1" } },
      ],
      [{ id: "w1", organization_id: ORG, direction: "inbound", type: "text", contact_id: "k3", body: "ok, confirmado amanhã 14h", media_derived_text: null, sent_at: "2026-11-27T10:00:00Z", conversations: { is_group: false, assigned_to_user_id: "u2" } }],
    );
    const vistos: string[] = [];
    const modelo = async (texto: string) => {
      vistos.push(texto);
      return texto.includes("quinta")
        ? { intencao: "pede", inicio: "2026-12-03T10:00:00-03:00", assunto: "Proposta" }
        : { intencao: "nenhuma" };
    };

    const r = await rodadaDeReunioes(banco.admin, ORG, "America/Sao_Paulo", AGORA, modelo, "sistema");
    expect(r).toMatchObject({ classificadas: 2, propostas: 1 });
    expect(vistos).toHaveLength(2);
    expect(vistos.some((v) => v.includes("boleto"))).toBe(false);
    // The model counts "amanhã" from the message's own date.
    expect(vistos.every((v) => v.startsWith("Enviada em: "))).toBe(true);
    expect(banco.propostas.find((p) => p.source_id === "e1")).toMatchObject({ status: "proposta", owner_user_id: "u1", contact_id: "k1" });
    expect(banco.propostas.find((p) => p.source_id === "w1")).toMatchObject({ status: "nenhuma", excerpt: null });

    await rodadaDeReunioes(banco.admin, ORG, "America/Sao_Paulo", AGORA, modelo, "sistema");
    expect(vistos).toHaveLength(2);
  });

  it("a refused call (budget) stops the round and stores nothing for that message", async () => {
    const banco = bancoFalso([], [{ id: "w1", organization_id: ORG, direction: "inbound", type: "text", contact_id: "k3", body: "reunião amanhã?", media_derived_text: null, sent_at: "2026-11-27T10:00:00Z", conversations: { is_group: false, assigned_to_user_id: null } }]);
    const r = await rodadaDeReunioes(banco.admin, ORG, "America/Sao_Paulo", AGORA, async () => {
      const e = new Error("Teto mensal da org esgotado");
      Object.defineProperty(e, "name", { value: "llm_budget_exceeded" });
      throw e;
    }, "sistema");
    expect(r.erro).toBe("Teto mensal da org esgotado");
    expect(banco.propostas).toHaveLength(0);
  });

  it("an unreadable answer is stored once as nothing found; a provider error skips only that message", async () => {
    const banco = bancoFalso([], [
      { id: "w1", organization_id: ORG, direction: "inbound", type: "text", contact_id: "k1", body: "reunião amanhã?", media_derived_text: null, sent_at: "2026-11-27T08:00:00Z", conversations: { is_group: false, assigned_to_user_id: null } },
      { id: "w2", organization_id: ORG, direction: "inbound", type: "text", contact_id: "k2", body: "call sexta 10h?", media_derived_text: null, sent_at: "2026-11-27T09:00:00Z", conversations: { is_group: false, assigned_to_user_id: null } },
      { id: "w3", organization_id: ORG, direction: "inbound", type: "audio", contact_id: "k3", body: "", media_derived_text: "podemos marcar uma visita?", sent_at: "2026-11-27T10:00:00Z", conversations: { is_group: false, assigned_to_user_id: null } },
    ]);
    const modelo = async (entrada: string) => {
      const texto = entrada.split("\n\n").slice(1).join("\n\n");
      if (texto.includes("amanhã")) return "texto solto, sem ferramenta";
      if (texto.includes("sexta")) throw new Error("content filter");
      return { intencao: "pede", inicio: null };
    };
    const r = await rodadaDeReunioes(banco.admin, ORG, "America/Sao_Paulo", AGORA, modelo, "sistema");
    expect(r).toMatchObject({ classificadas: 2, recusadas: 1 });
    expect(r.erro).toBeUndefined();
    expect(banco.propostas.find((p) => p.source_id === "w1")).toMatchObject({ status: "nenhuma" });
    // Refused while the provider answered others: about the message itself, never paid again.
    expect(banco.propostas.find((p) => p.source_id === "w2")).toMatchObject({ status: "nenhuma", excerpt: null });
    // An audio's transcript is read when the body is empty.
    expect(banco.propostas.find((p) => p.source_id === "w3")).toMatchObject({ status: "proposta", excerpt: "podemos marcar uma visita?" });
  });

  it("when nothing answered (provider trouble), refused messages are not settled: tried next round", async () => {
    const banco = bancoFalso([], [
      { id: "w1", organization_id: ORG, direction: "inbound", type: "text", contact_id: "k1", body: "reunião amanhã?", media_derived_text: null, sent_at: "2026-11-27T08:00:00Z", conversations: { is_group: false, assigned_to_user_id: null } },
    ]);
    const r = await rodadaDeReunioes(banco.admin, ORG, "America/Sao_Paulo", AGORA, async () => {
      throw new Error("503");
    }, "sistema");
    expect(r.recusadas).toBe(1);
    expect(banco.propostas).toHaveLength(0);
  });

  it("recognizes the budget refusal by its real name", () => {
    const e = new Error("Teto mensal");
    Object.defineProperty(e, "name", { value: "llm_budget_exceeded" });
    expect(ehRecusaDeOrcamento(e)).toBe(true);
    expect(ehRecusaDeOrcamento(new Error("content filter"))).toBe(false);
  });
});
