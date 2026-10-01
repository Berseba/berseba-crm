---
impacto: nada_mudou
secao: corrigido
titulo: Atualização pelo terminal não disputa mais com o agente, e os backups ficam só para o dono
---

Rodar `update.sh` no terminal agora segura a mesma trava que a atualização pela tela usa. Antes, o agente que roda a cada 5 minutos podia entrar no meio: numa instalação real ele trocou a senha interna das rotinas e religou o CRM antigo enquanto o banco estava sendo atualizado, e no fim o agendamento das automações ficou com a senha velha, recusado até alguém corrigir à mão. Agora o agente espera a atualização terminar, e o arquivo que as automações usam é sempre gravado com a senha que está no `.env` naquele momento. Se duas atualizações forem pedidas ao mesmo tempo, a segunda avisa na tela "Outra atualização (ou a troca automática da senha das rotinas) está rodando neste servidor. Espero ela terminar — até 30 min." e espera; se a primeira passar desse tempo, a segunda para dizendo "Outra atualização segue rodando neste servidor" e não mexe em nada. Basta rodar de novo depois.

Os backups (`backups/db-*.sql.gz`, `backups/waha-*.tgz` e os anexos) passam a ser gravados legíveis só pelo dono, e a pasta `backups/` fica fechada para os outros usuários do servidor. Quem aponta `BACKUP_DIR` para uma pasta própria continua com a permissão que deu a ela; só os arquivos de backup ficam fechados. Os backups antigos, que estavam abertos para leitura, são fechados no próximo backup, sem nenhum passo manual.
