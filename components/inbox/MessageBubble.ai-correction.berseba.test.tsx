/**
 * Berseba: on a bubble the AI agent sent, "Editar mensagem" and "Apagar para
 * todos" show only to a manager or admin (the same rule as the route).
 */
import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { MessageBubble } from "./MessageBubble";
import type { Message } from "@/lib/types/messaging";

function aiMessage(over: Partial<Message> = {}): Message {
  return {
    id: "m1",
    organization_id: "org1",
    conversation_id: "c1",
    channel_session_id: "s1",
    contact_id: "ct1",
    external_id: "AI-EXT",
    type: "text",
    direction: "outbound",
    status: "delivered",
    ack: null,
    error_code: null,
    error_message: null,
    body: "resposta errada da IA",
    media_url: null,
    media_mime: null,
    media_size_bytes: null,
    media_storage_path: null,
    sent_via: "ai",
    sent_by_user_id: null,
    sent_at: new Date().toISOString(),
    delivered_at: null,
    read_at: null,
    metadata: {},
    edited_at: null,
    revoked_at: null,
    reply_to_message_id: null,
    created_at: new Date().toISOString(),
    ...over,
  };
}

const handlers = () => ({
  onEditar: vi.fn(async () => undefined),
  onApagar: vi.fn(async () => undefined),
  onResponder: vi.fn(),
});

describe("MessageBubble — manager alters an AI message", () => {
  it("a manager edits and deletes an AI message for everyone", async () => {
    const user = userEvent.setup();
    const h = handlers();
    render(<MessageBubble message={aiMessage()} viewerUserId="u1" viewerRole="manager" {...h} />);
    await user.click(screen.getByRole("button", { name: "Opções da mensagem" }));
    await user.click(await screen.findByRole("menuitem", { name: "Editar mensagem" }));
    fireEvent.change(screen.getByRole("textbox", { name: "Editar mensagem" }), { target: { value: "resposta certa" } });
    fireEvent.click(screen.getByRole("button", { name: "Salvar" }));
    await waitFor(() => expect(h.onEditar).toHaveBeenCalledWith("resposta certa"));
    await user.click(screen.getByRole("button", { name: "Opções da mensagem" }));
    await user.click(await screen.findByRole("menuitem", { name: "Apagar para todos" }));
    fireEvent.click(screen.getAllByRole("button", { name: "Apagar para todos" }).at(-1)!);
    await waitFor(() => expect(h.onApagar).toHaveBeenCalledOnce());
  });

  it.each(["agent", "viewer", null])("role %s sees neither action on an AI message", async (role) => {
    const user = userEvent.setup();
    render(<MessageBubble message={aiMessage()} viewerUserId="u1" viewerRole={role} {...handlers()} />);
    await user.click(screen.getByRole("button", { name: "Opções da mensagem" }));
    await screen.findByRole("menuitem", { name: "Responder a esta mensagem" });
    expect(screen.queryByRole("menuitem", { name: "Editar mensagem" })).toBeNull();
    expect(screen.queryByRole("menuitem", { name: "Apagar para todos" })).toBeNull();
  });

  it("an admin does not get the actions on an automation message", async () => {
    const user = userEvent.setup();
    render(<MessageBubble message={aiMessage({ sent_via: "automation" })} viewerUserId="u1" viewerRole="admin" {...handlers()} />);
    await user.click(screen.getByRole("button", { name: "Opções da mensagem" }));
    await screen.findByRole("menuitem", { name: "Responder a esta mensagem" });
    expect(screen.queryByRole("menuitem", { name: "Editar mensagem" })).toBeNull();
    expect(screen.queryByRole("menuitem", { name: "Apagar para todos" })).toBeNull();
  });

  it("past 15 minutes a manager can still delete the AI message but no longer edit it", async () => {
    const user = userEvent.setup();
    const old = new Date(Date.now() - 16 * 60 * 1000).toISOString();
    render(<MessageBubble message={aiMessage({ sent_at: old })} viewerUserId="u1" viewerRole="manager" {...handlers()} />);
    await user.click(screen.getByRole("button", { name: "Opções da mensagem" }));
    await screen.findByRole("menuitem", { name: "Apagar para todos" });
    expect(screen.queryByRole("menuitem", { name: "Editar mensagem" })).toBeNull();
  });
});
