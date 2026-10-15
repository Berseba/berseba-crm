import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * THE CONTACT PANEL CAN BE OPENED AT EVERY WIDTH (#54).
 *
 * ## The defect
 *
 * The inline panel exists from `xl` (1280px) up. Below it the panel is a Sheet,
 * and its only trigger lived in the phone bar, which is `md:hidden`. So from
 * 768px to 1279px there was NO way to open it: tablets, small laptops and every
 * phone held in landscape (844–932px wide). Below 768px the trigger existed,
 * but as a borderless button in a bar of its own, away from the header.
 *
 * ## What is pinned here
 *
 * jsdom has no media queries, so the breakpoints are read from the classes the
 * build turns into them (the real CSS was measured in Chrome for the PR). The
 * rule is "exactly one of the two exists at every width": the trigger is
 * `xl:hidden` and has NO ancestor that hides it at a smaller breakpoint, and the
 * inline panel is `hidden xl:block`.
 *
 * The conversation is opened by deep link and the list NEVER answers: the object
 * comes only from the single fetch, which is the case of a push notification or
 * a link to a conversation outside the current tab.
 */

const { ORG, CONVERSA, ROW, auth } = vi.hoisted(() => {
  const ORG = "00000000-0000-4000-8000-0000000054aa";
  const CONVERSA = "00000000-0000-4000-8000-0000000054cc";
  const CONTATO = "00000000-0000-4000-8000-0000000054c1";
  return {
    ORG,
    CONVERSA,
    auth: { support: null as null | { access_mode: string } },
    ROW: {
      id: CONVERSA,
      organization_id: ORG,
      contact_id: CONTATO,
      channel_session_id: "sess-1",
      status: "open",
      service_revision: 1,
      assigned_to_user_id: null,
      assigned_to_user_name: null,
      tags: [],
      is_group: false,
      channel_sessions: null,
      contacts: {
        id: CONTATO,
        display_name: "Cliente da Ficha",
        name: "Cliente da Ficha",
        phone_number: "+5511999887654",
        tags: [],
      },
    },
  };
});

const get = vi.fn(async (bruta?: string): Promise<unknown> => {
  const url = bruta ?? "";
  // The list never answers: the conversation is NOT in it.
  if (url.startsWith("/api/v1/conversations?")) return new Promise(() => {});
  if (url === `/api/v1/conversations/${CONVERSA}`) return { data: ROW };
  if (url === "/api/v1/ai/automatico-ativo") return { data: { ativo: false } };
  return { data: [] };
});

vi.mock("@/lib/api/client", () => ({ apiClient: { get: (url: string) => get(url) } }));
vi.mock("@/components/feedback/ApiErrorToast", () => ({ showApiError: vi.fn() }));
vi.mock("@/lib/supabase/browser", () => ({
  prepareRealtimeAuthentication: vi.fn().mockResolvedValue(undefined),
  createClient: () => ({
    channel: () => ({ on: () => ({ subscribe: () => ({}) }), subscribe: () => ({}) }),
    removeChannel: () => {},
  }),
}));
vi.mock("next/navigation", () => ({
  usePathname: () => "/app/inbox",
  useRouter: () => ({ replace: vi.fn(), push: vi.fn() }),
  useSearchParams: () => new URLSearchParams(window.location.search),
}));
vi.mock("@/hooks/auth/AuthProvider", () => ({
  useAuth: () => ({
    user: { id: "u-1", role: "agent", support: auth.support },
    activeOrg: { orgId: ORG, role: "agent" },
  }),
  usePermission: () => true,
}));
vi.mock("@/hooks/inbox/useMarkAsRead", () => ({ useMarkAsRead: () => undefined }));
vi.mock("@/hooks/inbox/useClaimConversation", () => ({
  useClaimConversation: () => ({ mutate: vi.fn(), isPending: false }),
}));
vi.mock("@/hooks/inbox/useReleaseConversation", () => ({
  useReleaseConversation: () => ({ mutate: vi.fn(), isPending: false }),
}));
vi.mock("@/hooks/inbox/useCloseConversation", () => ({
  useCloseConversation: () => ({ mutate: vi.fn(), isPending: false }),
  useReopenConversation: () => ({ mutate: vi.fn(), isPending: false }),
  useArchiveConversation: () => ({ mutate: vi.fn(), isPending: false }),
}));
vi.mock("@/hooks/inbox/useResumeAiAttendance", () => ({
  useResumeAiAttendance: () => ({ mutate: vi.fn(), isPending: false }),
}));
vi.mock("@/hooks/inbox/usePauseAiAttendance", () => ({
  usePauseAiAttendance: () => ({ mutate: vi.fn(), isPending: false }),
}));
vi.mock("@/hooks/contacts/usePersonalContact", () => ({
  useMarkPersonalContact: () => ({ mutate: vi.fn(), isPending: false }),
  useUnmarkPersonalContact: () => ({ mutate: vi.fn(), isPending: false }),
}));
vi.mock("@/components/kanban/OwnerBadge", () => ({ OwnerBadge: () => null }));
vi.mock("@/components/inbox/ReassignDialog", () => ({ ReassignDialog: () => null }));
vi.mock("@/components/inbox/SnoozeButton", () => ({ SnoozeButton: () => null }));
vi.mock("@/components/inbox/JanelaSelo", () => ({ JanelaSelo: () => null }));
vi.mock("@/components/inbox/ChannelLogo", () => ({ ChannelLogo: () => null }));
vi.mock("@/components/voice/DialButton", () => ({ DialButton: () => null }));

/** The panel is a probe: it says which conversation it received. */
vi.mock("@/components/inbox/CRMSidePanel", () => ({
  CRMSidePanel: ({ conversation }: { conversation: { id: string } | null }) => (
    <div data-testid="painel">{conversation ? conversation.id : "sem-conversa"}</div>
  ),
}));
vi.mock("@/components/inbox/ConversationList", () => ({ ConversationList: () => null }));
vi.mock("@/components/inbox/InboxFilters", () => ({ InboxFilters: () => null }));
vi.mock("@/components/inbox/ChatThread", () => ({ ChatThread: () => null }));
vi.mock("@/components/inbox/Composer", () => ({ Composer: () => null }));
vi.mock("@/components/inbox/RetentionNotice", () => ({ RetentionNotice: () => null }));
vi.mock("@/components/inbox/NumeroForaDoAr", () => ({ NumeroForaDoAr: () => null }));
vi.mock("@/components/inbox/InboxKeyboardShortcuts", () => ({
  InboxKeyboardShortcuts: () => null,
}));
vi.mock("@/components/inbox/ShortcutsHelpDialog", () => ({ ShortcutsHelpDialog: () => null }));
vi.mock("@/components/inbox/JanelaFechadaAviso", () => ({ JanelaFechadaAviso: () => null }));

import { InboxLayout } from "@/components/inbox/InboxLayout";

function montar() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <InboxLayout initialSelectedId={CONVERSA} />
    </QueryClientProvider>,
  );
}

const classes = (el: Element) => (el.getAttribute("class") ?? "").split(/\s+/).filter(Boolean);

/**
 * Every class on the way up that hides the element at SOME width below `xl`.
 * `hidden` alone hides it everywhere; `md:hidden`, `sm:hidden` and `lg:hidden`
 * hide it in part of the range the trigger has to cover. `xl:hidden` and up is
 * the intended rule, not a defect.
 */
function escondeAbaixoDoXl(el: Element): string[] {
  const achados: string[] = [];
  for (let n: Element | null = el; n; n = n.parentElement) {
    for (const c of classes(n)) {
      if (c === "hidden" || /^(sm|md|lg):hidden$/.test(c)) achados.push(`${n.tagName}.${c}`);
    }
  }
  return achados;
}

async function portaDaFicha(): Promise<HTMLElement> {
  return screen.findByRole("button", { name: /Ficha/ });
}

describe("contact panel below xl (#54)", () => {
  beforeEach(() => {
    get.mockClear();
    auth.support = null;
    window.history.replaceState(null, "", "/app/inbox");
  });

  it("the trigger shows icon and label in the conversation HEADER, with no ancestor hiding it below xl", async () => {
    montar();
    const porta = await portaDaFicha();

    // In the header, next to the contact's name: not in a bar of its own.
    const titulo = screen.getByRole("heading", { name: "Cliente da Ficha" });
    expect(titulo.parentElement?.contains(porta)).toBe(true);

    expect(porta).toHaveTextContent("Ficha");
    expect(porta.querySelector("svg"), "the trigger carries the icon").not.toBeNull();

    expect(escondeAbaixoDoXl(porta)).toEqual([]);
    // CONTROL: the walk does find a hiding class when there is one. Without
    // this, a broken walk would make the assertion above pass for anything.
    const voltar = screen.getByRole("button", { name: "Conversas" });
    expect(escondeAbaixoDoXl(voltar)).toContain("DIV.md:hidden");
  });

  it("the trigger and the inline panel split the widths at the SAME breakpoint", async () => {
    montar();
    const porta = await portaDaFicha();
    const regraDaPorta = porta.closest(".xl\\:hidden");
    expect(regraDaPorta, "the trigger stops at xl, where the inline panel starts").not.toBeNull();

    const inline = screen
      .getAllByTestId("painel")
      .map((p) => p.parentElement!)
      .find((el) => classes(el).includes("xl:block"));
    expect(inline, "the inline panel is still there").toBeDefined();
    expect(classes(inline!)).toEqual(expect.arrayContaining(["hidden", "xl:block"]));
  });

  it("there is ONE trigger: the phone bar no longer carries its own", async () => {
    montar();
    await portaDaFicha();
    expect(screen.getAllByRole("button", { name: /Ficha/ })).toHaveLength(1);
  });

  it("opens the Sheet with the panel of the conversation that came from the link, not from the list", async () => {
    const user = userEvent.setup();
    montar();
    await user.click(await portaDaFicha());

    const folha = await screen.findByRole("dialog");
    expect(within(folha).getByText("Ficha do contato")).toBeInTheDocument();
    expect(within(folha).getByTestId("painel")).toHaveTextContent(CONVERSA);
    // CONTROL: the conversation is not in the list, it came from the single fetch.
    expect(get.mock.calls.map((c) => c[0])).toContain(`/api/v1/conversations/${CONVERSA}`);
  });

  it("read-only support also gets the trigger in its reduced header", async () => {
    auth.support = { access_mode: "support_readonly" };
    const user = userEvent.setup();
    montar();
    const porta = await portaDaFicha();
    expect(escondeAbaixoDoXl(porta)).toEqual([]);
    await user.click(porta);
    expect(within(await screen.findByRole("dialog")).getByTestId("painel")).toHaveTextContent(
      CONVERSA,
    );
  });
});
