import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { SecurityClient } from "./_client";

/**
 * Berseba: the organization niche picker (BERSEBA.md, "Organization niche").
 * `saude` arms the medical-emergency handoff and, when the organization never chose
 * it, upstream's clinical-claim layer (issue #35). A plain "Nicho salvo." would hide
 * that a safety control had just changed, so the toast names it.
 */

const patch = vi.hoisted(() => vi.fn());
const toastSuccess = vi.hoisted(() => vi.fn());
const toastWarning = vi.hoisted(() => vi.fn());

vi.mock("@/lib/api/client", () => ({ apiClient: { patch } }));
vi.mock("sonner", () => ({ toast: { success: toastSuccess, warning: toastWarning, error: vi.fn() } }));
vi.mock("@/app/actions/settings/regenerateRecoveryCodes", () => ({ regenerateRecoveryCodes: vi.fn() }));
vi.mock("@/app/actions/settings/signOutEverywhere", () => ({ signOutEverywhere: vi.fn() }));
vi.mock("@/app/actions/auth/politicaDeMfa", () => ({
  definirExigenciaDeMfa: vi.fn(),
  desativarMfaDaConta: vi.fn(),
}));
vi.mock("@/components/auth/RecoveryCodesPanel", () => ({ RecoveryCodesPanel: () => null }));
vi.mock("@/components/auth/MfaEnrollModal", () => ({ MfaEnrollModal: () => null }));
vi.mock("@/components/voice/PainelDeChamadaDeVoz", () => ({ PainelDeChamadaDeVoz: () => null }));

beforeAll(() => {
  // Radix Select needs pointer capture and scrollIntoView, which jsdom lacks.
  Element.prototype.hasPointerCapture ??= () => false;
  Element.prototype.setPointerCapture ??= () => {};
  Element.prototype.releasePointerCapture ??= () => {};
  Element.prototype.scrollIntoView ??= () => {};
});

beforeEach(() => {
  patch.mockReset().mockResolvedValue({ data: {} });
  toastSuccess.mockReset();
  toastWarning.mockReset();
});

function renderPicker(
  nicho: React.ComponentProps<typeof SecurityClient>["nicho"],
  clinicalClaimLayerOn = false,
) {
  return render(
    <SecurityClient
      mfaEnrolled={true}
      obrigatorio={false}
      podeExigirDaEquipe={false}
      papelMinimo="none"
      diasDeCarencia={0}
      podeConfigurarNicho={true}
      nicho={nicho}
      clinicalClaimLayerOn={clinicalClaimLayerOn}
    />,
  );
}

async function pick(label: string) {
  const user = userEvent.setup({ delay: null });
  await user.click(screen.getByRole("combobox", { name: "Nicho da organização" }));
  await user.click(await screen.findByRole("option", { name: label }));
}

describe("Settings › Security — organization niche picker", () => {
  it("the trigger has an accessible name", () => {
    renderPicker(null);
    expect(screen.getByRole("combobox", { name: "Nicho da organização" })).toBeTruthy();
  });

  it("leaving saude says the emergency handoff was turned off", async () => {
    renderPicker("saude");
    await pick("Nenhum");
    await waitFor(() => expect(patch).toHaveBeenCalledWith("/api/v1/settings/nicho", { nicho: null }));
    await waitFor(() =>
      expect(toastSuccess).toHaveBeenCalledWith(
        "Nicho salvo. A urgência médica deixou de ir direto para uma pessoa.",
      ),
    );
  });

  it("picking saude says when the clinical-claim layer was switched on", async () => {
    patch.mockResolvedValue({ data: { nicho: "saude", clinical_claim_layer: "enabled_now" } });
    renderPicker(null);
    await pick("Saúde");
    await waitFor(() => expect(patch).toHaveBeenCalledWith("/api/v1/settings/nicho", { nicho: "saude" }));
    await waitFor(() =>
      expect(toastSuccess).toHaveBeenCalledWith(
        "Nicho salvo. A conferência “Não fazer afirmação clínica” foi ligada.",
      ),
    );
  });

  it("picking saude with the layer already on keeps the plain message", async () => {
    patch.mockResolvedValue({ data: { nicho: "saude", clinical_claim_layer: "already_on" } });
    renderPicker(null);
    await pick("Saúde");
    await waitFor(() => expect(toastSuccess).toHaveBeenCalledWith("Nicho salvo."));
  });

  it("picking saude with the layer off by choice warns instead of saying all is well", async () => {
    patch.mockResolvedValue({ data: { nicho: "saude", clinical_claim_layer: "off_by_choice" } });
    renderPicker(null);
    await pick("Saúde");
    await waitFor(() =>
      expect(toastWarning).toHaveBeenCalledWith(
        "Nicho salvo, mas a conferência “Não fazer afirmação clínica” está desligada.",
      ),
    );
    expect(toastSuccess).not.toHaveBeenCalled();
    // the toast goes away; the notice under the picker stays
    expect(screen.getByTestId("aviso-conferencia-clinica-desligada").textContent).toContain("Abrir Agentes");
  });

  it("on load, saude with the layer off shows the persistent notice with a link to Agentes", () => {
    renderPicker("saude", false);
    const aviso = screen.getByTestId("aviso-conferencia-clinica-desligada");
    expect(aviso.getAttribute("role")).toBe("status");
    expect(aviso.querySelector("a")?.getAttribute("href")).toBe("/app/ai/agents");
  });

  it("no notice when the layer is on", () => {
    renderPicker("saude", true);
    expect(screen.queryByTestId("aviso-conferencia-clinica-desligada")).toBeNull();
  });

  it("no notice outside saude", () => {
    renderPicker("ecommerce", false);
    expect(screen.queryByTestId("aviso-conferencia-clinica-desligada")).toBeNull();
  });

  it("switching the layer on by picking saude removes the notice", async () => {
    patch.mockResolvedValue({ data: { nicho: "saude", clinical_claim_layer: "enabled_now" } });
    renderPicker(null, false);
    await pick("Saúde");
    await waitFor(() => expect(toastSuccess).toHaveBeenCalled());
    expect(screen.queryByTestId("aviso-conferencia-clinica-desligada")).toBeNull();
  });
});
