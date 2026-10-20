/**
 * A rota pública que troca o `[dk1:<base64url>]` por `[ref:XXXXXX]`.
 *
 * Cada caso aqui é um modo de falha concreto do caminho de quem CLICOU: hit
 * sem UTM nenhuma, organização que não existe, captura desligada e falha ao
 * gravar o ref. Nenhum deles pode virar tela de erro nem exceção — perder a
 * atribuição é aceitável, perder o lead não.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const estado = vi.hoisted(() => ({
  organizacao: { id: "org-a" } as { id: string } | null,
  config: {
    whatsapp_e164: "+5511999999999",
    message_template: "Olá! Vim pelo site. [ref:{token}]",
    enabled: true,
  } as { whatsapp_e164: string; message_template: string; enabled: boolean } | null,
  erroDoInsert: null as { code: string; message: string } | null,
  inserts: [] as Record<string, unknown>[],
  permitido: true,
  permitidoPorIp: true,
  // Berseba (#67): every `from(table)` call, in order.
  consultas: [] as string[],
}));

vi.mock("@/lib/ai/dispatcher/rate-limit", () => ({
  // Berseba (#67): `capture-ip:` is the IP-wide bucket, the rest is per (org, IP).
  checkRateLimit: async (chave: string) => ({
    allowed: chave.startsWith("capture-ip:") ? estado.permitidoPorIp : estado.permitido,
  }),
}));

vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({
    from: (tabela: string) => {
      estado.consultas.push(tabela);
      if (tabela === "meta_ads_click_refs") {
        return {
          insert: async (valores: Record<string, unknown>) => {
            estado.inserts.push(valores);
            return { error: estado.erroDoInsert };
          },
        };
      }
      const consulta: Record<string, unknown> = {};
      consulta.select = () => consulta;
      consulta.eq = () => consulta;
      consulta.maybeSingle = async () => ({
        data: tabela === "organizations" ? estado.organizacao : estado.config,
        error: null,
      });
      return consulta;
    },
  }),
}));

import { GET } from "@/app/api/v1/anuncios/meta/[org]/route";
import { extrairOrigemDaPagina, montarCodigoDeOrigemDoSite } from "@/lib/leads/origem-do-site";
import { PADRAO_DO_REF } from "@/lib/plataformas-de-anuncio/captura-de-clique";
import { casarClickRef } from "@/lib/plataformas-de-anuncio/meta/captura-de-clique";
import { textoSemRef } from "@/lib/plataformas-de-anuncio/pagina-de-captura";

const chamar = (query: string) =>
  GET(
    new NextRequest(`https://crm.example/api/v1/anuncios/meta/acme${query}`, {
      headers: { "x-forwarded-for": "203.0.113.7" },
    }),
    { params: Promise.resolve({ org: "acme" }) },
  );

const UTM_COMPLETA =
  "?utm_source=meta&utm_campaign=black-friday&utm_adset=mulheres-25-34&utm_ad=video-depoimento-v3";

beforeEach(() => {
  estado.organizacao = { id: "org-a" };
  estado.config = {
    whatsapp_e164: "+5511999999999",
    message_template: "Olá! Vim pelo site. [ref:{token}]",
    enabled: true,
  };
  estado.erroDoInsert = null;
  estado.inserts = [];
  estado.permitido = true;
  estado.permitidoPorIp = true;
  estado.consultas = [];
});

describe("GET /api/v1/anuncios/meta/[org]", () => {
  it("guarda as UTMs e manda para o WhatsApp com o ref no texto", async () => {
    const resposta = await chamar(UTM_COMPLETA);

    expect(resposta.status).toBe(302);
    const destino = decodeURIComponent(resposta.headers.get("location") ?? "");
    expect(destino).toContain("https://wa.me/5511999999999");
    expect(destino).toMatch(/\[ref:[2-9A-HJ-NP-Z]{6}\]/);

    expect(estado.inserts).toHaveLength(1);
    const linha = estado.inserts[0]!;
    expect(linha.organization_id).toBe("org-a");
    expect(linha.utm).toEqual({
      utm_source: "meta",
      utm_campaign: "black-friday",
      utm_adset: "mulheres-25-34",
      utm_ad: "video-depoimento-v3",
    });
  });

  it("o que não é chave de campanha não atravessa — nem para o ref, nem para a tabela", async () => {
    await chamar("?utm_campaign=black-friday&nome=Fulano&telefone=5511999999999");

    expect(estado.inserts[0]?.utm).toEqual({ utm_campaign: "black-friday" });
    // Berseba: `query_raw` keeps only the normalized keys too, so a name or
    // phone forwarded by the page never reaches the table.
    expect(estado.inserts[0]?.query_raw).toEqual({ utm_campaign: "black-friday" });
  });

  it("hit sem UTM nenhuma: vai para o WhatsApp sem ref, e não grava linha", async () => {
    const resposta = await chamar("");

    expect(resposta.status).toBe(302);
    const destino = decodeURIComponent(resposta.headers.get("location") ?? "");
    expect(destino).toContain("https://wa.me/5511999999999");
    expect(destino).not.toContain("[ref:");
    expect(estado.inserts).toHaveLength(0);
  });

  it("falha ao gravar o ref: a pessoa ainda chega no WhatsApp, só sem atribuição", async () => {
    estado.erroDoInsert = { code: "23503", message: "fk violation" };

    const resposta = await chamar(UTM_COMPLETA);

    expect(resposta.status).toBe(302);
    expect(decodeURIComponent(resposta.headers.get("location") ?? "")).not.toContain("[ref:");
  });

  it("organização inexistente: página neutra, nunca 500 nem 'esta organização não existe'", async () => {
    estado.organizacao = null;

    const resposta = await chamar(UTM_COMPLETA);

    // Sem organização não há número de WhatsApp para onde mandar — é o único
    // caminho em que a página neutra é o melhor desfecho possível.
    expect(resposta.status).toBe(404);
    expect(await resposta.text()).not.toContain("acme");
  });

  it("captura desligada: mesma régua da organização inexistente", async () => {
    estado.config = {
      whatsapp_e164: "+5511999999999",
      message_template: "Olá! Vim pelo site. [ref:{token}]",
      enabled: false,
    };

    const resposta = await chamar(UTM_COMPLETA);
    expect(resposta.status).toBe(404);
    expect(estado.inserts).toHaveLength(0);
  });

  // Berseba (#67): over the per-(org, IP) bucket the visitor still reaches
  // WhatsApp, only without the ref; the bare 429 is for the IP-wide bucket.
  it("per-(org, IP) bucket over: WhatsApp without ref, config read, no insert", async () => {
    estado.permitido = false;

    const resposta = await chamar(UTM_COMPLETA);

    expect(resposta.status).toBe(302);
    const destino = decodeURIComponent(resposta.headers.get("location") ?? "");
    expect(destino).toContain("https://wa.me/5511999999999");
    expect(destino).not.toContain("[ref:");
    expect(estado.inserts).toHaveLength(0);
    // The organization and its config are read (the visitor needs the
    // number), and the click table is never touched.
    expect(estado.consultas).toEqual(["organizations", "meta_ads_landing_pages"]);
  });

  it("IP-wide bucket over: bare 429 before any database call", async () => {
    estado.permitidoPorIp = false;

    const resposta = await chamar(UTM_COMPLETA);

    expect(resposta.status).toBe(429);
    expect(resposta.headers.get("Retry-After")).toBe("60");
    expect(await resposta.text()).toBe("");
    expect(estado.inserts).toHaveLength(0);
    // No organizations read, no config read, no insert: not a single `from()`.
    expect(estado.consultas).toEqual([]);
  });

  // Berseba: the slug is checked like the Google route's before it reaches the
  // rate-limit key or the lookup.
  it.each(["a b", "a.b", "x".repeat(101)])("bad slug %j: neutral page", async (org) => {
    const resposta = await GET(
      new NextRequest(`https://crm.example/api/v1/anuncios/meta/x${UTM_COMPLETA}`, {
        headers: { "x-forwarded-for": "203.0.113.7" },
      }),
      { params: Promise.resolve({ org }) },
    );

    expect(resposta.status).toBe(404);
    expect(estado.inserts).toHaveLength(0);
  });
});

// Berseba: `&texto=` carries the message of the button the visitor tapped.
describe("GET /api/v1/anuncios/meta/[org] with the button's message", () => {
  const TEXTO = "Olá! Quero agendar uma avaliação para gestantes 🤰";
  const comTexto = (texto: string) => `${UTM_COMPLETA}&texto=${encodeURIComponent(texto)}`;
  const mensagemDe = (resposta: Response) =>
    new URL(resposta.headers.get("location") ?? "").searchParams.get("text");
  const destinoDe = (resposta: Response) => {
    const url = new URL(resposta.headers.get("location") ?? "");
    return `${url.origin}${url.pathname}`;
  };

  it("with texto and UTM: the message is the texto followed by the ref", async () => {
    const resposta = await chamar(comTexto(TEXTO));

    expect(resposta.status).toBe(302);
    expect(destinoDe(resposta)).toBe("https://wa.me/5511999999999");
    const mensagem = mensagemDe(resposta) ?? "";
    expect(mensagem.startsWith(`${TEXTO} `)).toBe(true);
    expect(mensagem.slice(TEXTO.length + 1)).toMatch(/^\[ref:[2-9A-HJ-NP-Z]{6}\]$/);
    expect(estado.inserts).toHaveLength(1);
  });

  it("the ref in the message is the one that was stored", async () => {
    const resposta = await chamar(comTexto(TEXTO));
    const token = /\[ref:([2-9A-HJ-NP-Z]{6})\]/.exec(mensagemDe(resposta) ?? "")?.[1];

    expect(token).toBeDefined();
    expect(estado.inserts[0]?.token).toBe(token);
  });

  it("with texto and no UTM: the texto without a ref, and no insert", async () => {
    const resposta = await chamar(`?texto=${encodeURIComponent(TEXTO)}`);

    expect(resposta.status).toBe(302);
    expect(destinoDe(resposta)).toBe("https://wa.me/5511999999999");
    expect(mensagemDe(resposta)).toBe(TEXTO);
    expect(estado.inserts).toHaveLength(0);
  });

  it("with texto and a failed insert: the texto without a ref", async () => {
    estado.erroDoInsert = { code: "23503", message: "fk violation" };

    const resposta = await chamar(comTexto(TEXTO));

    expect(mensagemDe(resposta)).toBe(TEXTO);
  });

  it("with texto and the per-(org, IP) bucket over: the texto without a ref, no insert", async () => {
    estado.permitido = false;

    const resposta = await chamar(comTexto(TEXTO));

    expect(resposta.status).toBe(302);
    expect(destinoDe(resposta)).toBe("https://wa.me/5511999999999");
    expect(mensagemDe(resposta)).toBe(TEXTO);
    expect(estado.inserts).toHaveLength(0);
  });

  it("without texto: the configured template, as before", async () => {
    const comRef = await chamar(UTM_COMPLETA);
    expect(mensagemDe(comRef)).toMatch(/^Olá! Vim pelo site\. \[ref:[2-9A-HJ-NP-Z]{6}\]$/);

    const semUtm = await chamar("");
    expect(mensagemDe(semUtm)).toBe("Olá! Vim pelo site.");
  });

  it.each(["", "   ", "[ref:K7M2P9]"])(
    "a texto with nothing in it (%j) falls back to the template",
    async (vazio) => {
      const comRef = await chamar(comTexto(vazio));
      expect(mensagemDe(comRef)).toMatch(/^Olá! Vim pelo site\. \[ref:[2-9A-HJ-NP-Z]{6}\]$/);

      const semUtm = await chamar(`?texto=${encodeURIComponent(vazio)}`);
      expect(mensagemDe(semUtm)).toBe("Olá! Vim pelo site.");
    },
  );

  it("a forged marker in the texto is removed: the only ref is the one we create", async () => {
    const resposta = await chamar(
      comTexto("Oi [ref:AAAAAA] tudo bem? [dk1:eyJ1dG1fc291cmNlIjoieCJ9]"),
    );

    const mensagem = mensagemDe(resposta) ?? "";
    expect(mensagem).not.toContain("AAAAAA");
    expect(mensagem).not.toContain("dk1");
    expect(mensagem.match(/\[ref:/g)).toHaveLength(1);
    expect(mensagem).toMatch(/^Oi tudo bem\? \[ref:[2-9A-HJ-NP-Z]{6}\]$/);
  });

  // Berseba: the strip is repeated until the text stops changing, so markers
  // built by nesting (`[re[ref:]f:ABCDEF]`) do not come back after one pass.
  const payloadDk1 = montarCodigoDeOrigemDoSite({ utm_source: "evil" })!;
  it.each([
    ["nested ref", "Oi [re[ref:]f:ABCDEF] tudo bem?"],
    ["triple nesting", "Oi [re[r[ref:]ef:]f:ABCDEF] tudo bem?"],
    ["nested dk1", `Oi [dk[dk1:]${payloadDk1.slice("[dk".length)} tudo bem?`],
  ])(
    "forged marker by %s: the final message has exactly one [ref: and it is ours",
    async (_, texto) => {
      const resposta = await chamar(comTexto(texto));

      const mensagem = mensagemDe(resposta) ?? "";
      expect(mensagem).toMatch(/^Oi tudo bem\? \[ref:[2-9A-HJ-NP-Z]{6}\]$/);
      expect(mensagem.match(/\[ref:/g)).toHaveLength(1);
      expect(PADRAO_DO_REF.exec(mensagem)?.[1]).toBe(estado.inserts[0]?.token);
      // The inbound side finds no origin of the page in it.
      expect(extrairOrigemDaPagina(mensagem)).toBeNull();
    },
  );

  it("an unterminated marker left in the texto is not read: the first ref read is ours", async () => {
    const resposta = await chamar(comTexto("Oi [ref:ABCDEF"));

    const mensagem = mensagemDe(resposta) ?? "";
    expect(PADRAO_DO_REF.exec(mensagem)?.[1]).toBe(estado.inserts[0]?.token);
  });

  it("nesting too deep to be a message: the template is used, never a half-stripped text", async () => {
    let nested = "[ref:ABCDEF]";
    for (let i = 0; i < 50; i += 1) nested = `[re${nested}f:]`;

    const resposta = await chamar(comTexto(`Oi ${nested}`));

    expect(mensagemDe(resposta)).toMatch(/^Olá! Vim pelo site\. \[ref:[2-9A-HJ-NP-Z]{6}\]$/);
  });

  it("a very long texto is capped at 300 characters before the ref", async () => {
    const resposta = await chamar(comTexto("a".repeat(5000)));

    const mensagem = mensagemDe(resposta) ?? "";
    expect(mensagem).toMatch(/^a{300} \[ref:[2-9A-HJ-NP-Z]{6}\]$/);
  });

  it("the number is always the configured one, whatever the query says", async () => {
    const resposta = await chamar(
      `${comTexto("Chame o 5599888887777")}&whatsapp=5599888887777&phone=5599888887777`,
    );

    expect(destinoDe(resposta)).toBe("https://wa.me/5511999999999");
  });

  it("the texto never reaches the stored row: not in utm, not in query_raw", async () => {
    await chamar(comTexto(TEXTO));

    expect(estado.inserts).toHaveLength(1);
    const linha = estado.inserts[0]!;
    expect(linha.utm).toEqual({
      utm_source: "meta",
      utm_campaign: "black-friday",
      utm_adset: "mulheres-25-34",
      utm_ad: "video-depoimento-v3",
    });
    expect(linha.query_raw).toEqual(linha.utm);
    expect(JSON.stringify(linha)).not.toContain("gestantes");
    expect(Object.keys(linha.utm as object)).not.toContain("texto");
    expect(Object.keys(linha.query_raw as object)).not.toContain("texto");
  });
});

describe("textoSemRef", () => {
  it("tira o marcador INTEIRO, não só o placeholder", () => {
    // `[ref:]` na mensagem do lead não casa com padrão nenhum na ingestão e
    // lê como link quebrado para quem recebe.
    expect(textoSemRef("Olá! Vim pelo site. [ref:{token}]")).toBe("Olá! Vim pelo site.");
  });

  it("template que escreve o placeholder fora de colchetes também sai limpo", () => {
    expect(textoSemRef("Vim pelo site {token}")).toBe("Vim pelo site");
  });
});

const ORG = "11111111-1111-1111-1111-111111111111";
const CONTATO = "33333333-3333-3333-3333-333333333333";

describe("casarClickRef (Meta)", () => {
  /** O construtor do PostgREST, com os filtros anotados para o caso conferir. */
  function adminQueDevolve(data: unknown, filtros: Record<string, unknown> = {}) {
    const construtor = {
      update: () => construtor,
      eq: (campo: string, valor: unknown) => {
        filtros[campo] = valor;
        return construtor;
      },
      is: (campo: string, valor: unknown) => {
        filtros[campo] = valor;
        return construtor;
      },
      select: () => construtor,
      maybeSingle: async () => ({ data, error: null }),
    };
    return { from: () => construtor };
  }

  it("consome o ref e devolve as UTMs guardadas no clique", async () => {
    const filtros: Record<string, unknown> = {};
    const admin = adminQueDevolve({ utm: { utm_campaign: "black-friday" } }, filtros);

    const casado = await casarClickRef(admin as never, ORG, "K7M2P9", CONTATO);

    expect(casado).toEqual({ utm: { utm_campaign: "black-friday" } });
    // Organização no filtro é a lição da #236; `matched_at is null` é a trava
    // de consumo único.
    expect(filtros.organization_id).toBe(ORG);
    expect(filtros.token).toBe("K7M2P9");
    expect(filtros.matched_at).toBeNull();
  });

  it("ref já consumido não casa (o UPDATE não acha linha)", async () => {
    const casado = await casarClickRef(adminQueDevolve(null) as never, ORG, "K7M2P9", CONTATO);
    expect(casado).toBeNull();
  });

  it("linha sem UTM não vira atribuição", async () => {
    const casado = await casarClickRef(adminQueDevolve({ utm: {} }) as never, ORG, "K7M2P9", CONTATO);
    expect(casado).toBeNull();
  });
});
