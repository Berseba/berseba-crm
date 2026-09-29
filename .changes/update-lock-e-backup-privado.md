---
impacto: nada_mudou
secao: corrigido
titulo: Atualização pelo terminal não disputa mais com o agente, e os backups ficam só para o dono
---

Rodar `update.sh` no terminal agora segura a mesma trava que a atualização pela tela usa. Antes, o agente que roda a cada 5 minutos podia entrar no meio: numa instalação real ele trocou a senha interna das rotinas e religou o CRM antigo enquanto o banco estava sendo atualizado, e no fim o agendamento das automações ficou com a senha velha, recusado até alguém corrigir à mão. Agora o agente espera a atualização terminar, e o arquivo que as automações usam é sempre gravado com a senha que está no `.env` naquele momento. Se duas atualizações forem pedidas ao mesmo tempo, a segunda espera a primeira e, se ela passar de 30 minutos, para sem mexer em nada.

Os backups (`backups/db-*.sql.gz`, `backups/waha-*.tgz` e os anexos) passam a ser gravados legíveis só pelo dono, e a pasta `backups/` fica fechada para os outros usuários do servidor. Os backups antigos, que estavam abertos para leitura, são fechados no próximo backup, sem nenhum passo manual.
