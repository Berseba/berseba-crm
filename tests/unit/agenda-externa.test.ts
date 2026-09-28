/**
 * A grade externa — o que precisa ser verdade para a IA não oferecer vaga que
 * não existe, e para a turma de um público não vazar na busca de outro.
 */
import { describe, expect, it } from "vitest";

import {
  criarAdaptadorAdminFit,
  type LinhaDaGradeAdminFit,
  type TransporteAdminFit,
} from "@/lib/agenda-externa/adminfit";
import { lerConfig } from "@/lib/agenda-externa";
import type { ConfigDeAgendaExterna } from "@/lib/agenda-externa/tipos";

const CONFIG: ConfigDeAgendaExterna = {
  provedor: "adminfit",
  baseUrl: "https://exemplo.invalid",
  fuso: "America/Sao_Paulo",
  modalidades: {
    funcional: { rotulo: "Novum Funcional", externo: "NOVUM" },
    personalizado: { rotulo: "Treinos Personalizados", externo: "PERSONALIZADO" },
  },
};

const INTERVALO = { de: "2026-09-15", ate: "2026-09-22" };

/** Grade que mistura tudo, como a tela real do cliente mistura. */
const GRADE: ReadonlyArray<LinhaDaGradeAdminFit> = [
  { dia: "2026-09-18", hora: "07:00", modalidadeExterna: "NOVUM", vagasLivres: 5, capacidade: 16, turma: "Manhã" },
  { dia: "2026-09-16", hora: "07:00", modalidadeExterna: "NOVUM", vagasLivres: 0, capacidade: 16, turma: "Manhã" },
  { dia: "2026-09-16", hora: "16:00", modalidadeExterna: "KIDS", vagasLivres: 4, capacidade: 12, turma: "Kids" },
  { dia: "2026-09-17", hora: "19:00", modalidadeExterna: "BALLET", vagasLivres: 9, capacidade: 15, turma: "Ballet" },
  { dia: "2026-09-16", hora: "09:00", modalidadeExterna: "PERSONALIZADO", vagasLivres: null, capacidade: 7, turma: null },
];

const transporteFake = (grade = GRADE): TransporteAdminFit => async () => grade;

describe("grade externa — configuração por organização", () => {
  it("lê uma configuração válida de settings", () => {
    const c = lerConfig({ agenda_externa: CONFIG });
    expect(c?.provedor).toBe("adminfit");
    expect(Object.keys(c?.modalidades ?? {})).toEqual(["funcional", "personalizado"]);
  });

  it("organização sem agenda externa devolve null, não erro", () => {
    expect(lerConfig({})).toBeNull();
    expect(lerConfig(null)).toBeNull();
    expect(lerConfig({ agenda_externa: null })).toBeNull();
  });

  it("configuração sem nenhuma modalidade válida é tratada como ausente", () => {
    // Senão a consulta responderia "sem vagas" — uma mentira com cara de resposta.
    expect(lerConfig({ agenda_externa: { ...CONFIG, modalidades: {} } })).toBeNull();
    expect(
      lerConfig({ agenda_externa: { ...CONFIG, modalidades: { x: { rotulo: "" , externo: "" } } } }),
    ).toBeNull();
  });

  it("campo trocado não derruba o turno — degrada para 'sem agenda externa'", () => {
    expect(lerConfig({ agenda_externa: { ...CONFIG, fuso: "" } })).toBeNull();
    expect(lerConfig({ agenda_externa: { ...CONFIG, provedor: "outro" } })).toBeNull();
  });
});

describe("grade externa — a turma certa para o público certo", () => {
  it("busca de funcional NÃO devolve turma infantil nem de dança", async () => {
    const a = criarAdaptadorAdminFit(CONFIG, transporteFake());
    const r = await a.consultar({ modalidade: "funcional", ...INTERVALO });

    expect(r.situacao).toBe("ok");
    if (r.situacao !== "ok") return;
    expect(r.vagas).toHaveLength(2);
    expect(r.vagas.every((v) => v.modalidade.rotulo === "Novum Funcional")).toBe(true);
  });

  it("CONTROLE: a grade do teste realmente contém Kids e dança", () => {
    // Sem isto, o teste acima passaria vacuamente se a grade fosse só de funcional.
    expect(GRADE.some((l) => l.modalidadeExterna === "KIDS")).toBe(true);
    expect(GRADE.some((l) => l.modalidadeExterna === "BALLET")).toBe(true);
  });

  it("modalidade fora do mapa não consulta nada — recusa, não devolve tudo", async () => {
    const a = criarAdaptadorAdminFit(CONFIG, transporteFake());
    const r = await a.consultar({ modalidade: "kids", ...INTERVALO });
    expect(r.situacao).toBe("indisponivel");
  });

  it("devolve em ordem de dia e hora", async () => {
    const a = criarAdaptadorAdminFit(CONFIG, transporteFake());
    const r = await a.consultar({ modalidade: "funcional", ...INTERVALO });
    if (r.situacao !== "ok") throw new Error("esperava ok");
    expect(r.vagas.map((v) => `${v.dia} ${v.hora}`)).toEqual([
      "2026-09-16 07:00",
      "2026-09-18 07:00",
    ]);
  });
});

describe("grade externa — zero vagas e vagas desconhecidas são coisas diferentes", () => {
  it("turma cheia vem como 0, e não some da lista", async () => {
    const a = criarAdaptadorAdminFit(CONFIG, transporteFake());
    const r = await a.consultar({ modalidade: "funcional", ...INTERVALO });
    if (r.situacao !== "ok") throw new Error("esperava ok");
    expect(r.vagas.find((v) => v.dia === "2026-09-16")?.vagasLivres).toBe(0);
  });

  it("vaga não informada permanece nula — nunca vira 0", async () => {
    // Virar 0 faria a IA dizer "está lotado" sobre algo que ela não sabe.
    const a = criarAdaptadorAdminFit(CONFIG, transporteFake());
    const r = await a.consultar({ modalidade: "personalizado", ...INTERVALO });
    if (r.situacao !== "ok") throw new Error("esperava ok");
    expect(r.vagas[0]?.vagasLivres).toBeNull();
  });
});

describe("grade externa — falha fecha, não inventa", () => {
  it("sem transporte decidido, responde indisponível", async () => {
    const a = criarAdaptadorAdminFit(CONFIG); // transporte padrão = recusa
    const r = await a.consultar({ modalidade: "funcional", ...INTERVALO });
    expect(r.situacao).toBe("indisponivel");
  });

  it("transporte que explode vira estado, não exceção", async () => {
    const quebrado: TransporteAdminFit = async () => {
      throw new Error("sessão expirada");
    };
    const a = criarAdaptadorAdminFit(CONFIG, quebrado);
    const r = await a.consultar({ modalidade: "funcional", ...INTERVALO });
    expect(r.situacao).toBe("indisponivel");
    if (r.situacao !== "indisponivel") return;
    expect(r.motivo).toContain("sessão expirada");
  });

  it("grade vazia é 'ok' com lista vazia — não é falha e não é lotação", async () => {
    const a = criarAdaptadorAdminFit(CONFIG, transporteFake([]));
    const r = await a.consultar({ modalidade: "funcional", ...INTERVALO });
    expect(r.situacao).toBe("ok");
    if (r.situacao !== "ok") return;
    expect(r.vagas).toEqual([]);
  });
});
