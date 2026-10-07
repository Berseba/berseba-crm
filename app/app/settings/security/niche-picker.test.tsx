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

vi.mock("@/lib/api/client", () => ({ apiClient: { patch } }));
vi.mock("sonner", () => ({ toast: { success: toastSuccess, error: vi.fn() } }));
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
});

function renderPicker(nicho: React.ComponentProps<typeof SecurityClient>["nicho"]) {
  return render(
    <SecurityClient
      mfaEnrolled={true}
      obrigatorio={false}
      podeExigirDaEquipe={false}
      papelMinimo="none"
      diasDeCarencia={0}
      podeConfigurarNicho={true}
      nicho={nicho}
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
    patch.mockResolvedValue({ data: { nicho: "saude", clinical_claim_layer_enabled: true } });
    renderPicker(null);
    await pick("Saúde");
    await waitFor(() => expect(patch).toHaveBeenCalledWith("/api/v1/settings/nicho", { nicho: "saude" }));
    await waitFor(() =>
      expect(toastSuccess).toHaveBeenCalledWith(
        "Nicho salvo. A conferência “Não fazer afirmação clínica” foi ligada.",
      ),
    );
  });

  it("picking saude when the org already chose the layer keeps the plain message", async () => {
    patch.mockResolvedValue({ data: { nicho: "saude", clinical_claim_layer_enabled: false } });
    renderPicker(null);
    await pick("Saúde");
    await waitFor(() => expect(toastSuccess).toHaveBeenCalledWith("Nicho salvo."));
  });
});
