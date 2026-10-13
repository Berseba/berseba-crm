-- manifest: **gpt-6-luna (OpenAI) enters the selectable catalog and the cost table.** It runs in production (comments in `lib/agent-engine/edge/llm/providers.ts` and `inbound-turn.ts`, measured 2026-09-24) but had no row in `ai_models` (so the agent's ModelPicker did not list it) nor in `ai_pricing` (so `llm_calls.cost_cents` stayed NULL and the monthly budget never counted it). Price from OpenAI's pricing page, read 2026-10-21: US$ 0.10 / 0.50 per 1M tokens = 10/50 cents, the same numbers as `pricing.ts`. Idempotent: `on conflict do update` on both tables; same block appended to `baseline.sql`.
-- ---------------------------------------------------------------------------
-- 9003 — gpt-6-luna in the catalog (`ai_models`) and in the bill (`ai_pricing`)
--
-- Same shape as 0104/0386: the two tables move TOGETHER, because
-- tests/invariants/catalogo-de-modelos.test.ts fails when the price on screen
-- and the price the budget uses diverge. The `ai_pricing.notes` keeps the
-- `catálogo` prefix the provenance invariant requires (price from the
-- appendix, not from the 0068/0113 self-healing backfill).
--
-- Not the OpenAI default: `gpt-5.6-terra` stays the default for a fresh
-- install. `context_window` and `released_at` stay NULL on purpose — no
-- measured value, and the screen handles null.
--
-- `supports_vision` is left at its default: for a direct provider the vision
-- decision comes from the capability registry, never from this column
-- (`lib/ai/pontos/capacidade-em-vigor.ts`), so this row changes no runtime
-- behavior beyond listing and pricing.
--
-- Price source: developers.openai.com/api/docs/pricing, read 2026-10-21
-- (US$ 0.10 input, US$ 0.01 cached input, US$ 0.50 output per 1M tokens).
-- Confirmed by Matheus the same day, when GPT-6 Luna became the default.
-- ---------------------------------------------------------------------------
insert into public.ai_models
  (provider, model_id, display_name, description,
   input_price_per_million_cents, output_price_per_million_cents, supports_tools)
values
  ('openai', 'gpt-6-luna', 'GPT-6 Luna',
   'O mais barato da linha 6, rápido para atendimento e tarefas simples.', 10, 50, true)
on conflict (provider, model_id) do update set
  display_name = excluded.display_name,
  description = excluded.description,
  input_price_per_million_cents = excluded.input_price_per_million_cents,
  output_price_per_million_cents = excluded.output_price_per_million_cents,
  supports_tools = excluded.supports_tools,
  deprecated_at = null;

insert into public.ai_pricing
  (model, prompt_cents_per_million_tokens, completion_cents_per_million_tokens, notes)
values
  ('gpt-6-luna', 10, 50, 'catálogo 9003 — OpenAI pricing page, read 2026-10-21: US$ 0.10 / 0.50 per 1M, cached input 0.01; same numbers as pricing.ts')
on conflict (model) do update set
  prompt_cents_per_million_tokens = excluded.prompt_cents_per_million_tokens,
  completion_cents_per_million_tokens = excluded.completion_cents_per_million_tokens,
  notes = excluded.notes,
  superseded_at = null;
