import { describe, expect, it, vi } from "vitest";

const ORG = "11111111-1111-4111-8111-111111111111";

vi.mock("@/lib/env", () => ({
  env: {
    GMAIL_INTAKE_ORG_IDS: ` ${ORG.toUpperCase()} , not-a-uuid`,
    GMAIL_INTAKE_ACCOUNTS: "Socio@Empresa.com.br, nao-e-email",
    GMAIL_INTAKE_CLIENT_ID: "",
    GMAIL_INTAKE_CLIENT_SECRET: "",
    INTERNAL_SECRET: "x".repeat(32),
    NEXT_PUBLIC_APP_URL: "https://crm.exemplo.com.br",
  },
}));
vi.mock("@/lib/agenda/google/config", () => ({ configuracaoDoGoogle: async () => null }));

const { capacidadesDoGmail, contaPermitida, gmailIntakeConfigFor, parseGmailIntakeConfig, urlDeConsentimentoDoGmail } =
  await import("./config");
const { buscaDoGmail, lerEmail, lerEnderecos, textoDoHtml, TETO_DO_CORPO } = await import("./message");
const { escolherDaRodada, proximoMarco } = await import("./intake");
const { conversasDeEmail } = await import("./conversas");

const b64 = (s: string) => Buffer.from(s, "utf8").toString("base64url");
const CAIXA = "socio@empresa.com.br";

function mensagem(over: {
  from?: string;
  to?: string;
  cc?: string;
  labels?: string[];
  headers?: Array<{ name: string; value: string }>;
  payload?: Record<string, unknown>;
}) {
  return {
    id: "m1",
    threadId: "t1",
    labelIds: over.labels ?? ["INBOX"],
    snippet: "Oi, tudo bem?",
    internalDate: String(Date.UTC(2026, 10, 26, 12, 0, 0)),
    payload: {
      mimeType: "multipart/alternative",
      headers: [
        { name: "From", value: over.from ?? '"Ana Souza" <Ana@Cliente.com>' },
        { name: "To", value: over.to ?? CAIXA },
        ...(over.cc ? [{ name: "Cc", value: over.cc }] : []),
        { name: "Subject", value: "Proposta" },
        ...(over.headers ?? []),
      ],
      parts: [
        { mimeType: "text/plain", body: { data: b64("Podemos falar amanhã às 10h?") } },
        { mimeType: "text/html", body: { data: b64("<p>Podemos falar</p>") } },
      ],
      ...(over.payload ?? {}),
    },
  };
}

describe("config", () => {
  it("is off unless both allowlists have a valid entry", () => {
    expect(parseGmailIntakeConfig({})).toBeNull();
    expect(parseGmailIntakeConfig({ orgIds: ORG })).toBeNull();
    expect(parseGmailIntakeConfig({ contas: "a@b.com" })).toBeNull();
    expect(parseGmailIntakeConfig({ orgIds: "x", contas: "a@b.com" })).toBeNull();
  });

  it("gates by organization and by mailbox, case-insensitively", () => {
    const config = gmailIntakeConfigFor(ORG);
    expect(config).not.toBeNull();
    expect(gmailIntakeConfigFor("99999999-9999-4999-8999-999999999999")).toBeNull();
    expect(capacidadesDoGmail(ORG)).toEqual(["emails_gmail"]);
    expect(capacidadesDoGmail("99999999-9999-4999-8999-999999999999")).toEqual([]);
    expect(contaPermitida(config!, " SOCIO@empresa.com.br ")).toBe(true);
    expect(contaPermitida(config!, "outra@empresa.com.br")).toBe(false);
    expect(contaPermitida(config!, null)).toBe(false);
  });

  it("asks only gmail.readonly, offline, with the account chooser", () => {
    const url = new URL(
      urlDeConsentimentoDoGmail(
        { clientId: "cid", clientSecret: "s", redirectUri: "https://crm.exemplo.com.br/api/v1/gmail/callback" },
        { state: "st", contaSugerida: CAIXA },
      ),
    );
    expect(url.searchParams.get("scope")).toBe("https://www.googleapis.com/auth/gmail.readonly");
    expect(url.searchParams.get("access_type")).toBe("offline");
    expect(url.searchParams.get("prompt")).toBe("consent select_account");
    expect(url.searchParams.get("redirect_uri")).toBe("https://crm.exemplo.com.br/api/v1/gmail/callback");
    expect(url.searchParams.get("login_hint")).toBe(CAIXA);
  });
});

describe("lerEnderecos", () => {
  it("reads names, quoted commas and bare addresses; drops non-addresses", () => {
    expect(lerEnderecos('"Souza, Ana" <ana@x.com>, BOB@Y.COM, lixo, Carla <carla@z.com.br>')).toEqual([
      { email: "ana@x.com", nome: "Souza, Ana" },
      { email: "bob@y.com", nome: null },
      { email: "carla@z.com.br", nome: "Carla" },
    ]);
    expect(lerEnderecos(null)).toEqual([]);
  });
});

describe("lerEmail", () => {
  it("an inbound from a client: counterpart is the sender, plain text body", () => {
    const e = lerEmail(mensagem({}), CAIXA)!;
    expect(e.direction).toBe("inbound");
    expect(e.from_email).toBe("ana@cliente.com");
    expect(e.from_name).toBe("Ana Souza");
    expect(e.counterpart_email).toBe("ana@cliente.com");
    expect(e.body_text).toBe("Podemos falar amanhã às 10h?");
    expect(e.subject).toBe("Proposta");
    expect(e.sent_at).toBe("2026-11-26T12:00:00.000Z");
    expect(e.is_automated).toBe(false);
  });

  it("an outbound: counterpart is the first recipient outside the mailbox's domain", () => {
    const e = lerEmail(
      mensagem({ from: CAIXA, to: "outro@empresa.com.br", cc: "Ana <ana@cliente.com>", labels: ["SENT"] }),
      CAIXA,
    )!;
    expect(e.direction).toBe("outbound");
    expect(e.counterpart_email).toBe("ana@cliente.com");
    expect(e.is_automated).toBe(false);
  });

  it("mail only between the partners is not stored", () => {
    expect(lerEmail(mensagem({ from: "outro@empresa.com.br" }), CAIXA)).toBeNull();
    expect(lerEmail(mensagem({ from: CAIXA, to: "outro@empresa.com.br", labels: ["SENT"] }), CAIXA)).toBeNull();
  });

  it("newsletters, notifications and auto-replies are marked automated", () => {
    expect(lerEmail(mensagem({ from: "no-reply@banco.com" }), CAIXA)!.is_automated).toBe(true);
    expect(
      lerEmail(mensagem({ headers: [{ name: "List-Unsubscribe", value: "<mailto:x@y.com>" }] }), CAIXA)!.is_automated,
    ).toBe(true);
    expect(lerEmail(mensagem({ headers: [{ name: "Auto-Submitted", value: "auto-replied" }] }), CAIXA)!.is_automated).toBe(
      true,
    );
    expect(lerEmail(mensagem({ headers: [{ name: "Auto-Submitted", value: "no" }] }), CAIXA)!.is_automated).toBe(false);
  });

  it("falls back to the HTML part, caps the body, and sees attachments", () => {
    const longo = "a".repeat(TETO_DO_CORPO + 50);
    const e = lerEmail(
      mensagem({
        payload: {
          parts: [
            { mimeType: "text/html", body: { data: b64(`<style>x{}</style><p>Olá&nbsp;<b>Ana</b></p><p>${longo}</p>`) } },
            { mimeType: "application/pdf", filename: "proposta.pdf", body: { attachmentId: "att1", size: 10 } },
          ],
        },
      }),
      CAIXA,
    )!;
    expect(e.body_text!.startsWith("Olá Ana")).toBe(true);
    expect(e.body_text!.length).toBe(TETO_DO_CORPO);
    expect(e.has_attachments).toBe(true);
  });

  it("refuses a message without id, sender or date", () => {
    expect(lerEmail({ ...mensagem({}), id: undefined }, CAIXA)).toBeNull();
    expect(lerEmail({ ...mensagem({}), internalDate: "x" }, CAIXA)).toBeNull();
    expect(lerEmail(mensagem({ from: "sem endereço" }), CAIXA)).toBeNull();
  });
});

describe("textoDoHtml", () => {
  it("drops tags, scripts and entities", () => {
    expect(textoDoHtml("<script>alert(1)</script><div>A &amp; B</div><br>C")).toBe("A & B\n\nC");
  });
});

describe("the run", () => {
  it("searches from one hour before the mark, without chats or the promotion tabs", () => {
    const q = buscaDoGmail(new Date("2026-11-26T12:00:00Z"));
    expect(q).toBe(
      `after:${Date.UTC(2026, 10, 26, 11, 0, 0) / 1000} -in:chats -category:promotions -category:social -category:forums`,
    );
  });

  it("reads the oldest new ids first, at most the cap", () => {
    const listados = ["n5", "n4", "old", "n3", "n2", "n1"]; // Gmail lists newest first
    expect(escolherDaRodada(listados, new Set(["old"]), 3)).toEqual({ ler: ["n1", "n2", "n3"], restam: true });
    expect(escolherDaRodada(listados, new Set(["old"]), 10)).toEqual({
      ler: ["n1", "n2", "n3", "n4", "n5"],
      restam: false,
    });
  });

  it("moves the mark to now when caught up, to the newest read when capped, never back", () => {
    const agora = new Date("2026-11-26T12:00:00Z");
    const lido = (sent_at: string) => ({ sent_at }) as never;
    expect(proximoMarco(null, [], false, agora)).toBe(agora.toISOString());
    expect(proximoMarco(null, [lido("2026-11-20T00:00:00.000Z"), lido("2026-11-21T00:00:00.000Z")], true, agora)).toBe(
      "2026-11-21T00:00:00.000Z",
    );
    expect(proximoMarco("2026-11-22T00:00:00.000Z", [lido("2026-11-21T00:00:00.000Z")], true, agora)).toBe(
      "2026-11-22T00:00:00.000Z",
    );
    expect(proximoMarco("2026-11-22T00:00:00.000Z", [], true, agora)).toBe("2026-11-22T00:00:00.000Z");
  });
});

describe("conversasDeEmail", () => {
  it("one line per mailbox thread, newest on top, automated only when all are", () => {
    const base = {
      from_name: null,
      subject: "Proposta",
      snippet: null,
      counterpart_email: "ana@cliente.com",
      contact_id: null,
      from_email: "ana@cliente.com",
    };
    const linhas = conversasDeEmail([
      { ...base, id: "3", mailbox_id: "c1", gmail_thread_id: "t1", direction: "outbound", is_automated: false, sent_at: "3" },
      { ...base, id: "2", mailbox_id: "c1", gmail_thread_id: "t1", direction: "inbound", is_automated: false, sent_at: "2", from_name: "Ana", contact_id: "k1" },
      { ...base, id: "1", mailbox_id: "c2", gmail_thread_id: "t1", direction: "inbound", is_automated: true, sent_at: "1" },
    ]);
    expect(linhas).toHaveLength(2);
    expect(linhas[0]).toMatchObject({
      chave: "c1:t1",
      mensagens: 2,
      ultimaDirecao: "outbound",
      nomeDaContraparte: "Ana",
      contact_id: "k1",
      automatica: false,
    });
    expect(linhas[1]).toMatchObject({ chave: "c2:t1", automatica: true });
  });
});
