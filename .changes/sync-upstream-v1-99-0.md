---
impacto: exige_acao
secao: alterado
titulo: Sincronização com o DeskcommCRM v1.99.0 (vinha da v1.87.0)
---

O produto passa a incluir tudo o que o fornecedor lançou entre a v1.87.0 e a v1.99.0. As notas de cada versão estão nas releases dele:

- [v1.99.0](https://github.com/melgarafael/DeskcommCRM/releases/tag/v1.99.0)
- [v1.98.0](https://github.com/melgarafael/DeskcommCRM/releases/tag/v1.98.0)
- [v1.97.0](https://github.com/melgarafael/DeskcommCRM/releases/tag/v1.97.0)
- [v1.96.0](https://github.com/melgarafael/DeskcommCRM/releases/tag/v1.96.0)
- [v1.95.0](https://github.com/melgarafael/DeskcommCRM/releases/tag/v1.95.0)
- [v1.94.0](https://github.com/melgarafael/DeskcommCRM/releases/tag/v1.94.0)
- [v1.93.0](https://github.com/melgarafael/DeskcommCRM/releases/tag/v1.93.0)
- [v1.92.0](https://github.com/melgarafael/DeskcommCRM/releases/tag/v1.92.0)
- [v1.91.0](https://github.com/melgarafael/DeskcommCRM/releases/tag/v1.91.0)
- [v1.90.0](https://github.com/melgarafael/DeskcommCRM/releases/tag/v1.90.0)
- [v1.89.0](https://github.com/melgarafael/DeskcommCRM/releases/tag/v1.89.0)
- [v1.88.0](https://github.com/melgarafael/DeskcommCRM/releases/tag/v1.88.0)

## Requer atenção

O fornecedor pediu ação do operador nestas versões — leia antes de atualizar:

**v1.98.0**

- **Conta, recorrência, lançamento manual e parcela de honorários gravam na moeda da organização** A API do catálogo do financeiro (`POST` e `PATCH` em `/api/v1/financeiro/catalogo/contas`) deixa de ler o campo `currency` do corpo. Uma integração que criava conta em moeda diferente da organização passa a ter a conta na moeda da organização, sem erro, porque o campo é ignorado. Também não dá mais para trocar a moeda de uma conta existente por essa rota. Se a sua integração dependia disso, ajuste antes de atualizar.

  As respostas de lançamentos e de parcelas de honorários passam a trazer o campo `currency`.

  Contribuição de @webtecnica (#3459).

**v1.97.0**

- **Campos de seleção passam a gravar a opção do funil, não o texto cru** Se uma integração sua (pela API) ou o agente de IA grava num campo do tipo "Lista de uma escolha", "Lista de várias escolhas" ou "Lista pesquisável" (sem "permitir valor novo") um valor que não está entre as opções cadastradas no funil, essa escrita passa a ser recusada com o erro `custom_field_value_not_in_list`, e nada é gravado. Antes de atualizar, cadastre no funil as opções que faltam ou ajuste a integração.

  O valor que casa com uma opção é gravado pelo valor dela (`sp`, não `São Paulo`): se a sua integração lê o campo de volta esperando o texto que enviou, ela passa a receber o valor da opção. Numa lista de várias escolhas, o texto `casa, apartamento` passa a ser gravado como lista (`["casa","apto"]`).

  Formulários de captação não são recusados: o valor fora da lista entra como veio.

**v1.91.0**

- **A trava de número novo passa a segurar os retornos automáticos até você liberar o número na Central** Se algum número seu ainda não cumpre essas condições (em geral, o que começou a enviar há menos de 31 dias), os retornos automáticos dele param depois da atualização e esperam na fila, sem se perder. Abra a **Central**, procure o aviso "Número novo aguardando liberação (go-live)" e marque como resolvido quando o número estiver pronto para disparar. Nenhum arquivo precisa ser editado.

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
