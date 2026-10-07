import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { SecurityClient } from "./_client";

/**
 * Berseba: the organization niche picker (BERSEBA.md, "Organization niche").
 * `saude` arms both clinical brakes, so leaving it must say so — a plain
 * "Nicho salvo." hid that a safety control had just been switched off.
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

  it("leaving saude says the clinical brakes were turned off", async () => {
    renderPicker("saude");
    await pick("Nenhum");
    await waitFor(() => expect(patch).toHaveBeenCalledWith("/api/v1/settings/nicho", { nicho: null }));
    await waitFor(() =>
      expect(toastSuccess).toHaveBeenCalledWith("Nicho salvo. Os freios clínicos foram desligados."),
    );
  });

  it("any other change keeps the plain message", async () => {
    renderPicker(null);
    await pick("Saúde");
    await waitFor(() => expect(patch).toHaveBeenCalledWith("/api/v1/settings/nicho", { nicho: "saude" }));
    await waitFor(() => expect(toastSuccess).toHaveBeenCalledWith("Nicho salvo."));
  });
});
