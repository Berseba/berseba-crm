# Incidente 2026-09-28: Inbox lenta e com erro no Studio Bruno Alves

Para: Matheus. Autor: Samuel/Claude. Status: causa identificada. Paliativo aplicado em produção (migração 0239); o conserto definitivo e a entrada da 0239 no repo estão pendentes.

## Resumo

- O Inbox do CRM (crm.grupoberseba.com.br) mostrou toasts de erro porque `GET /api/v1/conversations/counts` e a lista da Fila passaram de 10 s.
- A causa é a função SQL `comando_da_conversa`, avaliada por linha junto com a RLS, e disparada 4x por carga do Inbox. Com várias pessoas logadas, o banco satura.
- Não é proxy, rede, `.env` nem recurso da VPS. O conserto proposto é reescrever a função agora e materializar o comando como coluna depois.

## Sintomas

- Samuel: vários toasts "Erro inesperado. Tente novamente." ao abrir o Inbox.
- Blenda (Studio): "Erro interno. Tente de novo em instantes. ID: d598b8e0-a9db-42ce-aa5b-e978a65517ef" às 15:49, na conversa de um contato.
- Os dois textos vêm de caminhos diferentes:
  - "Erro inesperado": o fetch não recebeu resposta. `lib/api/client.ts` usa `DEFAULT_TIMEOUT_MS = 10_000`. Quando o erro não é `ApiError`, o cliente mostra o toast genérico.
  - "Erro interno": o servidor respondeu HTTP 5xx.

## Linha do tempo (28/09, BRT)

- 27–28/09: proxy trocado para o infra-caddy compartilhado.
- 9h, 14h e 15h: 21 ocorrências de "aborting with incomplete response" no Caddy, todas em HTTP/3.
- 11:47: `.env` alterado (só `RESEND_API_KEY` e `RESEND_FROM_EMAIL`).
- 15:39: Matheus desligou HTTP/3 no Caddy (`protocols h1 h2`).
- 15:49: erro da Blenda (ID d598b8e0-...).
- Depois disso: diagnóstico no navegador, na VPS e no banco (números abaixo).

## Ambiente

- VPS 187.77.227.242 (Hostinger srv1980870). Container `deskcommcrm-app-1`, imagem `ghcr.io/samuelnishioka/deskcommcrm:stable`. Código em `/root/berseba/solutions/deskcommcrm` (HEAD 6400eb4).
- Supabase `vdtpyqvqxanoowrmixit`.
- Org afetada: Studio Bruno Alves (`a9ac5b93-...`), com 146 das 204 conversas do banco.

## Causa raiz

`comando_da_conversa(c conversations)` foi criada em `supabase/migrations/20260831000000_0203_comando_da_conversa.sql`. Espelho em TS: `lib/inbox/comando-da-conversa.ts`.

1. É avaliada linha a linha. O Postgres não faz inline dela porque o corpo tem subconsultas. O `SET search_path` (linha 78) **não** é o problema: medido, a mesma função sem o `SET` deu 493 ms contra 491.
2. Dentro dela há duas subconsultas separadas em `public.contacts`, uma para `force_human` e outra para `is_blocked` (linhas 87–88). Cada uma passa pela RLS de `contacts`: `fn_user_org_ids()` (SECURITY DEFINER, com union) e `fn_support_context()`.
3. A RLS de `conversations` (`fn_can_view_conversation`) também roda por linha e chama `fn_user_role_in_org` duas vezes.
4. O Inbox dispara isso 4x por carga (a lista e mais 3 contagens em paralelo) e refaz a carga de tempos em tempos. Com várias pessoas logadas, a média sobe para 5 s.
5. Consulta que passa de 8 s bate no `statement_timeout` do papel `authenticated` e é cancelada. Aí `app/api/v1/conversations/counts/route.ts:83` devolve `fail("internal_error", firstErr.message, 500, { requestId })` sem gravar log. Por isso o ID da Blenda não aparece em lugar nenhum.
6. O custo cresce de forma linear com o número de conversas da org.

## Evidência

Navegador (perfil logado, h2), `GET /api/v1/conversations/counts`:

| Tentativa | Tempo | Resultado |
|---|---|---|
| 1 | 1,97 s | 200 |
| 2 | 49,8 s | falhou (status 0) |
| 3 | 1,6 s | 200 |
| 4 | 56,3 s | 200 |

Todas as outras chamadas levaram de 0,2 a 0,4 s.

`pg_stat_statements` (reset em 14/09):
- Total de execução: 21,3 h (cerca de 1,5 h por dia).
- Lista da Fila (PostgREST em `conversations`, filtro por `organization_id` + `comando_da_conversa = ANY`, `ORDER BY last_inbound_at`, embeds `contacts` e `channel_sessions`): 10.972 chamadas, média de 5.130 ms, máximo de 8.000 ms, 15,64 h no total. Isso é 73% de todo o tempo do banco.
- Contagens do counts (`comando_da_conversa = $2` / `ANY`): média de cerca de 2,3 s, máximo de cerca de 8 s.

`EXPLAIN ANALYZE` como o usuário (admin do Studio), com o banco ocioso:
- Fila: 540 ms. Desse total, 491 ms ficam no Bitmap Heap Scan em `conversations`, com `Filter: fn_can_view_conversation(...) AND comando_da_conversa(c.*) = ANY('{aguardando}')`, que remove 141 das 146 linhas.
- Abrir uma conversa isolada: 14 ms.

## O que NÃO é causa

- **Troca para o infra-caddy compartilhado (27–28/09).** Houve um problema, mas é outro: 21 "aborting with incomplete response", todos em HTTP/3, às 9h, 14h e 15h. O Matheus desligou o HTTP/3 às 15:39 (`protocols h1 h2`). A mudança está correta e resolveu esse problema.
- **`.env` alterado às 11:47.** Só mudaram `RESEND_API_KEY` e `RESEND_FROM_EMAIL`.
- **Rede VPS→Supabase.** Responde em 0,07 s. O IPv6 falha rápido, sem travar.
- **Recursos da VPS.** Nenhum restart, nenhum OOM, CPU perto de 0, 6 GB livres.
- **Lock no banco.** No momento da medição não havia lock nem query presa.

## Conserto proposto

1. **Imediato (migration):** reescrever `comando_da_conversa` com uma leitura só em `contacts`, trazendo `force_human` e `is_blocked` de uma vez. **Aplicado**, ver abaixo.
2. **Definitivo:** materializar o comando como coluna em `conversations`, mantida por trigger ou na escrita, com índice `(organization_id, comando_da_conversa, last_inbound_at)`. Atenção: o comando depende de `now()` por causa de `bot_silenced_until`, então a coluna precisa ser recalculada quando esse prazo vence.
3. Espaçar o refetch das contagens no Inbox.
4. Gravar log da causa em todo `fail` 5xx (começando por `counts/route.ts`).
5. Ligar o access log no infra-caddy.

## Conserto aplicado

Paliativo aplicado em produção em 28/09, depois das 16h (BRT), com aprovação do Samuel: migração
`supabase/migrations/20260928200000_0239_comando_da_conversa_uma_leitura_de_contato.sql`.

- `comando_da_conversa` passa a ler `contacts` **uma vez** (LEFT JOIN LATERAL trazendo
  `force_human` e `is_blocked`) em vez de duas subconsultas. Continua SECURITY INVOKER, com a RLS
  de quem chama. Segurança inalterada. `proacl` preservado.
- Aplicada numa transação guardada: o comando das 205 conversas foi salvo antes, a função foi
  trocada, comparado depois. **0 diferenças.** Se houvesse 1, a transação abortava.
- Medido depois, como admin do Studio: contagem da Fila 491 → ~270 ms e lista da Fila 540 → 280 ms.
  No navegador, `/api/v1/conversations/counts` 6× seguidas: 1,0–1,2 s, todas 200, sem toast.
- **Não está no repo remoto nem no `update.sh`:** o arquivo está só na cópia local do Samuel
  (branch `wip/agenda-externa`, sem commit). Precisa entrar no repo, senão uma reinstalação volta
  a 0203.

Testada e **não aplicada**: uma versão SECURITY DEFINER com a checagem de tenant dentro da função
(membro direto → `fn_user_org_ids()` → platform admin, mais `ct.organization_id =
c.organization_id`). Ela deu 114 ms na Fila e 71 ms na contagem, com 0 diferenças, e um usuário
sem vínculo recebeu "sem acesso" numa linha forjada. Ficou fora porque tira a leitura de
`contacts` da RLS, e essa decisão de modelo de segurança é tua.

O conserto definitivo continua sendo o item 2 acima (coluna materializada e indexada). O
paliativo só reduz a constante: o custo ainda cresce com o número de conversas da org.

## Problemas paralelos

- **Log a cada minuto no Studio:** "credencial da organização não pôde ser lida; seguindo para a chave da instalação".
- **`[media-derive] failed permanently — Unsupported state or unable to authenticate data`:** é falha de autenticação AES-GCM, ou seja, um dado cifrado que não abre com a chave atual. Hipótese não verificada: o dado foi gravado antes da reinstalação de 23/09, quando o `.env` antigo se perdeu.
- **500 sem log:** a rota `counts` devolve 500 sem gravar a causa. Outras rotas provavelmente fazem o mesmo.
- **Sem access log no Caddy compartilhado:** não há como ver os 5xx por lá.

## Pendências

- Levar a 0239 para o repo pelo caminho da doutrina: linha no `MANIFEST.md`, apêndice no `supabase/baseline.sql`, `pnpm test:db`, PR. Sem o apêndice, a próxima reinstalação volta à 0203.
- Acompanhar a média real da Fila no `pg_stat_statements` nos próximos dias. O acumulado desde 14/09 ainda carrega a versão antiga.
- Decidir e implementar a coluna materializada (item 2).
- Espaçar o refetch das contagens (item 3).
- Logar os 5xx nas rotas da API (item 4).
- Access log no infra-caddy (item 5, Matheus).
- Verificar a hipótese do AES-GCM: quais registros falham e de quando são.
- Investigar a credencial da org do Studio que não pode ser lida.

## Método

- Acesso via `ssh deskcomm`.
- Leituras no banco feitas numa sessão com `set session characteristics as transaction read only`. Foi verificado que a escrita é recusada.
- O script temporário `/tmp/q.sh` foi removido depois.
- Nada foi alterado no servidor, no banco ou no git.
