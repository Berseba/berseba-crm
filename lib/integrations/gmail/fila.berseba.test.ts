import { describe, expect, it } from "vitest";

import type { MensagemGuardada } from "./conversas";
import { emailsAguardandoResposta } from "./fila";

let n = 0;
function msg(over: Partial<MensagemGuardada> & Pick<MensagemGuardada, "direction" | "sent_at">): MensagemGuardada {
  n += 1;
  const cliente = over.counterpart_email ?? "ana@cliente.com";
  return {
    id: `m${n}`,
    mailbox_id: "cx1",
    gmail_thread_id: "t1",
    from_email: over.direction === "inbound" ? cliente : "socio@empresa.com.br",
    from_name: over.direction === "inbound" ? "Ana" : null,
    subject: "Proposta",
    snippet: "…",
    is_automated: false,
    counterpart_email: cliente,
    contact_id: null,
    ...over,
  };
}

describe("emailsAguardandoResposta", () => {
  it("the client wrote last: waits since their first message after our last one", () => {
    const fila = emailsAguardandoResposta([
      msg({ direction: "inbound", sent_at: "2026-11-20T10:00:00Z" }),
      msg({ direction: "outbound", sent_at: "2026-11-21T10:00:00Z" }),
      msg({ direction: "inbound", sent_at: "2026-11-22T10:00:00Z" }),
      msg({ direction: "inbound", sent_at: "2026-11-23T10:00:00Z", contact_id: "k1" }),
    ]);
    expect(fila).toHaveLength(1);
    expect(fila[0]).toMatchObject({ desde: "2026-11-22T10:00:00Z", contraparte: "ana@cliente.com", contact_id: "k1" });
  });

  it("we wrote last: nothing owed", () => {
    expect(
      emailsAguardandoResposta([
        msg({ direction: "inbound", sent_at: "2026-11-20T10:00:00Z" }),
        msg({ direction: "outbound", sent_at: "2026-11-21T10:00:00Z" }),
      ]),
    ).toEqual([]);
  });

  it("the other partner answered from their own inbox (another mailbox, another thread): settled", () => {
    expect(
      emailsAguardandoResposta([
        msg({ direction: "inbound", sent_at: "2026-11-20T10:00:00Z" }),
        msg({ direction: "outbound", sent_at: "2026-11-20T12:00:00Z", mailbox_id: "cx2", gmail_thread_id: "t9" }),
      ]),
    ).toEqual([]);
  });

  it("automated mail and a partner's mail with the client in copy never wait", () => {
    expect(
      emailsAguardandoResposta([
        msg({ direction: "inbound", sent_at: "2026-11-20T10:00:00Z", is_automated: true, from_email: "news@x.com", counterpart_email: "news@x.com" }),
        msg({ direction: "inbound", sent_at: "2026-11-21T10:00:00Z", gmail_thread_id: "t2", from_email: "outro@empresa.com.br" }),
      ]),
    ).toEqual([]);
  });

  it("an automated reply after the client's message does not hide the wait", () => {
    const fila = emailsAguardandoResposta([
      msg({ direction: "inbound", sent_at: "2026-11-20T10:00:00Z" }),
      msg({ direction: "inbound", sent_at: "2026-11-20T10:01:00Z", is_automated: true }),
    ]);
    expect(fila).toHaveLength(1);
  });

  it("oldest wait first", () => {
    const fila = emailsAguardandoResposta([
      msg({ direction: "inbound", sent_at: "2026-11-25T10:00:00Z", gmail_thread_id: "novo", counterpart_email: "b@x.com" }),
      msg({ direction: "inbound", sent_at: "2026-11-20T10:00:00Z", gmail_thread_id: "velho", counterpart_email: "c@x.com" }),
    ]);
    expect(fila.map((f) => f.gmail_thread_id)).toEqual(["velho", "novo"]);
  });
});
