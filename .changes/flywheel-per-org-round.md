---
impacto: nada_mudou
secao: corrigido
titulo: As Propostas de melhoria agora avaliam todas as organizações, sem repetir conversa
---

A rodada automática que gera as Propostas de melhoria dos agentes pegava as 10 conversas mais recentes do servidor inteiro. Numa instalação com várias organizações, a que mais atendia ocupava todas as vagas e as menores nunca recebiam proposta. Quando não havia conversa nova, as mesmas 10 eram avaliadas de novo a cada 6 horas, pagando a IA para chegar à mesma conclusão. E um erro em uma organização (sem saldo de IA, sem modelo configurado) interrompia a rodada de todas as outras.

Agora cada organização tem a sua própria cota por rodada (`FLYWHEEL_BATCH_LIMIT`, 10 por padrão, passou a valer por organização), cada conversa é avaliada uma vez só, considerando a última mensagem de cada contato nos últimos 7 dias, e o erro de uma organização não atrapalha as demais. Como antes, o custo de cada avaliação é registrado na organização dona da conversa e respeita o orçamento de IA dela.
