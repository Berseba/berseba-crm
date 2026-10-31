---
impacto: exige_acao
secao: alterado
titulo: Sincronização com o DeskcommCRM v1.90.0 (vinha da v1.87.0)
---

O produto passa a incluir tudo o que o fornecedor lançou entre a v1.87.0 e a v1.90.0. As notas de cada versão estão nas releases dele:

- [v1.90.0](https://github.com/melgarafael/DeskcommCRM/releases/tag/v1.90.0)
- [v1.89.0](https://github.com/melgarafael/DeskcommCRM/releases/tag/v1.89.0)
- [v1.88.0](https://github.com/melgarafael/DeskcommCRM/releases/tag/v1.88.0)

## Requer atenção

O fornecedor pediu ação do operador nestas versões — leia antes de atualizar:

**v1.88.0**

- **As execuções de IA mostram o provedor configurado no painel** Antes, modelo com barra no nome era registrado como OpenRouter; gasto e teto não mudam. Medido por @eduardosuruagy (#3098) e corrigido por @webtecnica (#3185).

- **A recusa da inscrição de push aparece na tela, e o interruptor não fica ligado mentindo** Quando o servidor ou o navegador recusa a inscrição, o interruptor desliga e a tela diz o motivo. Sem as chaves VAPID, ele fica ligado e o aviso da página explica. Contribuição de @webtecnica (#3157, #3164).

- **O restore do backup só diz que deu certo quando confere que os dados voltaram** O `restore.sh` compara, tabela por tabela, as linhas que o backup declara com as do banco; se não bater, para e diz qual tabela, o esperado e o achado. Segue usando a conta de banco da atualização. Conserto de @webtecnica, a partir do problema encontrado por @apoenondigitalmarketing numa VPS real (#2381).

- **Especialista de um roteador de intenções publica sem número próprio** Atende quando o roteador for ativado. Contribuição de @lucivan212 (#3284).

- **A instalação atrás de Traefik volta a conferir que a rota do Supabase chegou ao serviço de login** O fim do instalador reprova, com mensagem clara, quando `/auth/v1/*` no seu domínio cai no sistema em vez do serviço de login; sem resposta (certificado ainda saindo), só avisa. Nada muda em instalações no ar nem no proxy padrão. Crédito: @webtecnica.

- **Transferir a conversa leva o negócio aberto do contato, e assumir dá dono ao negócio sem responsável** Com mais de um negócio aberto visível, nada muda; vale a visibilidade de quem transfere (na padrão, de atendente para atendente o negócio não vai junto; vai quando transfere gerente ou administrador, ou com "todos veem tudo"), e assumir nunca tira o card de um colega nem de um agente de IA. A troca gera `lead.assigned` e o aviso "Lead atribuído a você": se a sua integração escuta `lead.assigned`, ela passa a recebê-lo também nas transferências do Inbox. Refs #3177.

- **O turno adiado pelo horário do agente não conta roteamento duas vezes** Contribuição de @webtecnica (#3215).

- **A segunda trava das receitas prontas volta a conferir as tabelas** A primeira trava não mudou. Nada muda para quem usa. Contribuição de @paulolimajr77 (#3203).

- **Um PDF recebido no WhatsApp não derruba mais o worker** Desde a 1.83.0 a leitura de PDF saiu do processo separado e podia reiniciar o worker, interrompendo respostas e acendendo o alerta "fila de eventos parada"; ela volta a rodar à parte. Contribuição de @Gervanno (#3186).
