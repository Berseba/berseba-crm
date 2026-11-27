import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/env", () => ({ env: {} }));
vi.mock("@/lib/agenda/google/token", () => ({ renovarToken: vi.fn() }));
vi.mock("@/lib/webhooks/secrets", () => ({
  decryptWebhookSecret: async () => "access-token",
  encryptWebhookSecret: async () => "\\x00",
}));

const { lerCaixa, TETO_POR_RODADA } = await import("./intake");

/**
 * The run loop against a fake Gmail and a fake database (only the chains `lerCaixa` uses). The two
 * scenarios the review found: internal mail must never stall the mark, and a window with more than
 * the list holds must not lose its older messages.
 */

type Linha = Record<string, unknown>;

function bancoFalso() {
  const tabelas: Record<string, Linha[]> = { gmail_messages: [], gmail_skipped_messages: [], gmail_mailboxes: [], contacts: [] };
  function consulta(tabela: string) {
    const filtros: Array<(l: Linha) => boolean> = [];
    let acao: "select" | "update" | "delete" | "upsert" = "select";
    let dados: Linha | Linha[] | null = null;
    const q = {
      select: () => q,
      eq: (c: string, v: unknown) => (filtros.push((l) => l[c] === v), q),
      in: (c: string, vs: unknown[]) => (filtros.push((l) => vs.includes(l[c])), q),
      is: (c: string, v: unknown) => (filtros.push((l) => (l[c] ?? null) === v), q),
      not: (c: string) => (filtros.push((l) => l[c] != null), q),
      lt: (c: string, v: string) => (filtros.push((l) => String(l[c]) < v), q),
      order: () => q,
      limit: () => q,
      update: (d: Linha) => ((acao = "update"), (dados = d), q),
      delete: () => ((acao = "delete"), q),
      upsert: (d: Linha[]) => ((acao = "upsert"), (dados = d), q),
      then: (ok: (r: { data: Linha[]; error: null }) => unknown) => {
        const linhas = tabelas[tabela]!;
        const casam = linhas.filter((l) => filtros.every((f) => f(l)));
        if (acao === "update") casam.forEach((l) => Object.assign(l, dados));
        if (acao === "delete") tabelas[tabela] = linhas.filter((l) => !casam.includes(l));
        if (acao === "upsert") {
          const novas = (dados as Linha[]).filter(
            (n) => !linhas.some((l) => l.mailbox_id === n.mailbox_id && l.gmail_message_id === n.gmail_message_id),
          );
          linhas.push(...novas.map((n) => ({ created_at: new Date().toISOString(), motivo: "ignorada", ...n })));
          return Promise.resolve(ok({ data: novas, error: null }));
        }
        return Promise.resolve(ok({ data: casam, error: null }));
      },
    };
    return q;
  }
  return { tabelas, admin: { from: (t: string) => consulta(t) } as never };
}

interface Msg {
  id: string;
  quando: number;
  de: string;
}

/** Fake Gmail: `after:`/`before:` filter, newest first, pages of 500, `format=full` reads. */
function gmailFalso(msgs: Msg[]) {
  const lidas: string[] = [];
  const f = (async (url: string) => {
    const u = new URL(url);
    if (u.pathname.endsWith("/messages")) {
      const q = u.searchParams.get("q")!;
      const depois = Number(q.match(/after:(\d+)/)![1]) * 1000;
      const antes = q.match(/before:(\d+)/) ? Number(q.match(/before:(\d+)/)![1]) * 1000 : Infinity;
      const todas = msgs.filter((m) => m.quando > depois && m.quando < antes).sort((a, b) => b.quando - a.quando);
      const inicio = Number(u.searchParams.get("pageToken") ?? 0);
      const max = Number(u.searchParams.get("maxResults"));
      const pagina = todas.slice(inicio, inicio + max);
      const proxima = inicio + max < todas.length ? String(inicio + max) : undefined;
      return new Response(JSON.stringify({ messages: pagina.map((m) => ({ id: m.id })), nextPageToken: proxima }));
    }
    const id = decodeURIComponent(u.pathname.split("/").pop()!);
    const m = msgs.find((x) => x.id === id)!;
    lidas.push(id);
    return new Response(
      JSON.stringify({
        id,
        threadId: `t-${id}`,
        labelIds: ["INBOX"],
        internalDate: String(m.quando),
        payload: { headers: [{ name: "From", value: m.de }, { name: "To", value: "socio@empresa.com.br" }] },
      }),
    );
  }) as typeof fetch;
  return { f, lidas };
}

const APP = { clientId: "c", clientSecret: "s", redirectUri: "https://x/cb" };
const AGORA = new Date("2026-11-26T12:00:00Z");

function caixaCom(synced_until: string | null) {
  return {
    id: "cx1",
    organization_id: "org1",
    account_email: "socio@empresa.com.br",
    oauth_access_token_encrypted: "\\x00",
    oauth_refresh_token_encrypted: "\\x00",
    token_expires_at: "2099-01-01T00:00:00Z",
    scopes: [],
    synced_until,
  };
}

async function rodar(banco: ReturnType<typeof bancoFalso>, f: typeof fetch, vezes: number) {
  banco.tabelas.gmail_mailboxes = [caixaCom(null)];
  for (let i = 0; i < vezes; i++) {
    const caixa = banco.tabelas.gmail_mailboxes[0] as ReturnType<typeof caixaCom>;
    await lerCaixa(banco.admin, APP, { ...caixa }, AGORA, f);
  }
  return banco.tabelas.gmail_mailboxes[0] as ReturnType<typeof caixaCom>;
}

describe("lerCaixa", () => {
  it("internal mail never stalls the intake: skipped ids are remembered and the mark moves", async () => {
    const base = AGORA.getTime() - 2 * 24 * 60 * 60 * 1000;
    const internas = Array.from({ length: 70 }, (_, i) => ({
      id: `int${i}`,
      quando: base + i * 1000,
      de: "outro@empresa.com.br",
    }));
    const cliente = { id: "cli1", quando: base + 100_000, de: "Ana <ana@cliente.com>" };
    const banco = bancoFalso();
    const { f, lidas } = gmailFalso([...internas, cliente]);

    const caixa = await rodar(banco, f, 3);

    expect(banco.tabelas.gmail_messages.map((m) => m.gmail_message_id)).toEqual(["cli1"]);
    expect(banco.tabelas.gmail_skipped_messages).toHaveLength(70);
    // Every message read exactly once, however many runs.
    expect(new Set(lidas).size).toBe(lidas.length);
    expect(caixa.synced_until).toBe(AGORA.toISOString());
  });

  it("a window with more than 500 messages loses none: the window narrows and every id is read", async () => {
    // 1,200 client e-mails inside one hour, 3 days ago.
    const base = AGORA.getTime() - 3 * 24 * 60 * 60 * 1000;
    const msgs = Array.from({ length: 1200 }, (_, i) => ({ id: `m${i}`, quando: base + i * 2000, de: `c${i}@cliente.com` }));
    const banco = bancoFalso();
    const { f, lidas } = gmailFalso(msgs);

    const runs = Math.ceil(1200 / TETO_POR_RODADA) + 2;
    const caixa = await rodar(banco, f, runs);

    expect(banco.tabelas.gmail_messages).toHaveLength(1200);
    expect(new Set(lidas).size).toBe(1200);
    expect(caixa.synced_until).toBe(AGORA.toISOString());
  });
});
