---
impacto: nada_mudou
secao: corrigido
titulo: Testar o agente espera a resposta do modelo em vez de desistir aos 10 segundos
---

Na aba **Teste** do agente, o ensaio abortava antes de o modelo terminar: a tela
esperava 10 segundos, desistia, tentava mais duas vezes por conta própria e
terminava em "Erro inesperado" — sem mostrar resposta nenhuma. Enquanto isso o
servidor seguia trabalhando, e cada tentativa era cobrada no provedor: um clique
virava três rodadas pagas e três runs presos em "executando".

Agora a tela espera até 3 minutos, o tempo que um ensaio completo leva de fato
(classificação, detecção de abuso, resposta e checkpoint). O atendimento real
pelo WhatsApp nunca foi afetado — só o botão de teste.
