---
impacto: exige_acao
secao: alterado
titulo: Sincronização com o DeskcommCRM v1.87.0 (vinha da v1.75.0)
---

O produto passa a incluir tudo o que o fornecedor lançou entre a v1.75.0 e a v1.87.0. As notas de cada versão estão nas releases dele:

- [v1.87.0](https://github.com/melgarafael/DeskcommCRM/releases/tag/v1.87.0)
- [v1.86.0](https://github.com/melgarafael/DeskcommCRM/releases/tag/v1.86.0)
- [v1.85.0](https://github.com/melgarafael/DeskcommCRM/releases/tag/v1.85.0)
- [v1.84.0](https://github.com/melgarafael/DeskcommCRM/releases/tag/v1.84.0)
- [v1.83.0](https://github.com/melgarafael/DeskcommCRM/releases/tag/v1.83.0)
- [v1.82.0](https://github.com/melgarafael/DeskcommCRM/releases/tag/v1.82.0)
- [v1.81.0](https://github.com/melgarafael/DeskcommCRM/releases/tag/v1.81.0)
- [v1.80.0](https://github.com/melgarafael/DeskcommCRM/releases/tag/v1.80.0)
- [v1.79.0](https://github.com/melgarafael/DeskcommCRM/releases/tag/v1.79.0)
- [v1.78.0](https://github.com/melgarafael/DeskcommCRM/releases/tag/v1.78.0)
- [v1.77.0](https://github.com/melgarafael/DeskcommCRM/releases/tag/v1.77.0)
- [v1.76.0](https://github.com/melgarafael/DeskcommCRM/releases/tag/v1.76.0)

## Requer atenção

O fornecedor pediu ação do operador nestas versões — leia antes de atualizar:

**v1.87.0**

- **O filtro de palavras do agente passa a valer** Se algum agente seu tem esse campo preenchido, ele vai passar a ficar calado em toda mensagem sem uma das palavras, inclusive no meio da conversa. Antes de atualizar, confira o campo na tela de cada agente. Se não quiser o filtro, deixe-o em branco e publique a versão de novo.
- **As condições das automações ganham "não contém", "está vazio", "está preenchido", comparação por número/data e o grupo "qualquer uma"** Revise as regras que usam "não é" (`neq`) num campo que pode estar AUSENTE (nulo, ou nunca preenchido): elas disparavam quando o campo não estava preenchido e agora não disparam mais. Para voltar a pegar o "não preencheu", troque a condição por "está vazio"; para "não é X e está preenchido", use "está preenchido" junto do "não é X". Em campo cujo valor é texto vazio nada muda — ali o `neq` continua igual.

  Não volte para a versão anterior DEPOIS de gravar uma regra "qualquer uma": a versão antiga não conhece o formato de grupo e a leitura das condições dela estoura ao avaliar, o que derruba as automações daquele gatilho inteiro — não só a regra nova. Se precisar voltar, desfaça antes as regras "qualquer uma" pelo formulário.

  Contribuição de @webtecnica (refs #2727).

**v1.86.0**

- **No funil, cada campo personalizado agora diz se é do contato ou do negócio** Se a sua equipe preenche campos personalizados na ficha do contato (ex.: CPF, nascimento), depois de atualizar abra Configurações › Funis, no funil padrão, e marque esses campos como "Contato". Até lá a ficha do contato não mostra campo personalizado nenhum. Os valores já gravados continuam guardados e voltam a aparecer quando o campo for marcado.

  Contribuição de @webtecnica (#2852), a partir da issue #2791.

**v1.85.0**

- **O custo das chamadas do provedor personalizado passa a ser calculado pelo preço do catálogo** Se você usa o provedor personalizado e tem teto de gasto de IA em modo de bloqueio, confira o teto antes de atualizar: as chamadas desse provedor passam a ser contadas pelo preço real, e o gasto do mês pode cruzar o limite e pausar a IA nas conversas.

**v1.84.0**

- **Com a cobrança ligada e planos oferecidos, defina um plano padrão — sem ele o cadastro pelo Google some e o cadastro sem plano é recusado** Vale para quem tem a cobrança ligada, oferece planos aos clientes e não tem nenhum marcado como **Plano do cadastro** (o padrão). Depois da atualização, nessa situação:

  - o "Entrar com Google" some da tela de cadastro;
  - o cadastro sem plano escolhido é recusado. Quem entra pela primeira vez com o Google pela tela de login, ou se cadastrou antes da atualização, escolhe o plano na tela seguinte ("Configure sua organização");
  - a integração que cria empresas por `POST /api/v1/tenants/provision` recebe `409 plano_obrigatorio`.

  Com um padrão de 0 dias de teste grátis, a empresa criada pela integração também nasce suspensa até o primeiro pagamento.

  Para evitar, escolha o plano padrão em Painel › Cobrança › Planos, no botão **Usar no cadastro** (o plano marcado passa a mostrar "Plano do cadastro"); a aba Planos avisa enquanto falta. Com o padrão definido, o Google volta, a integração volta a criar empresas e a empresa que entra sem escolher nasce no padrão.

  Contribuição de @omayklourenco (#2846).

**v1.83.0**

- **A agenda e as tarefas respeitam a visibilidade da empresa junto com a opção da agenda dos colegas** Confira Configurações › Agenda antes de avisar a equipe. Numa empresa com a opção "Atendentes podem mexer na agenda dos colegas" DESLIGADA, o atendente deixa de ver, marcar, alterar e cancelar compromisso na agenda de um colega, e deixa de ver, editar e excluir a tarefa que o colega escreveu e atribuiu a si. Se a sua operação depende de um atendente trabalhar a agenda de um colega, ligue essa opção de volta (ela é o padrão de fábrica) ou passe a visibilidade da empresa para "Todos veem tudo". Numa empresa com a opção LIGADA nada mudou: a agenda e as tarefas seguem da equipe para o atendente, como sempre.

**v1.81.0**

- **O pedido de dados que chega pela Nuvemshop passa a esperar o clique em Aprovar** Depois de atualizar, alguém com papel de administrador precisa aprovar cada pedido de dados que chegar pela Nuvemshop em Organização › LGPD. Sem a aprovação, o arquivo não é enviado e o prazo legal de 7 dias úteis corre. Confira também os pedidos que chegaram pouco antes da atualização e ainda aparecem como "Recebido": eles esperam a mesma aprovação.
- **Lembretes da agenda deixam de escolher arbitrariamente entre números da organização** Depois de atualizar, abra Configurações › Tipos de agendamento se a organização tem mais de um número. Escolha o canal do lembrete nos serviços que recebem reserva manual sem conversa; sem isso, o lembrete fica pendente com aviso na Central em vez de sair por um número qualquer. O mesmo vale para a reserva cuja conversa está num número desconectado ou arquivado: ela deixa de sair pelo número novo e fica pendente, o que atinge também quem trocou de número. Lembrete com a janela de 24 horas fechada passa a abrir aviso na Central.

**v1.79.0**

- **Só para quem alargou à mão a restrição de origem dos pedidos para gravar Tray, Loja Integrada ou WooCommerce** Troque a sua ponte para gravar a origem `external` (id `<plataforma>:<id>`, plataforma no `payload`) ANTES de rodar `bash update.sh`: depois da atualização, gravar o nome da plataforma é recusado e o pedido novo se perde. Os pedidos antigos são convertidos sozinhos. Quem não mexeu na restrição não faz nada.

**v1.78.0**

- **A assinatura do ChatGPT passa a funcionar nos agentes, com login próprio e lista de modelos por empresa** Quem conectou a assinatura do ChatGPT antes desta versão precisa conectar de novo: em **IA › Credenciais**, use o link de conexão da assinatura e entre com a mesma conta. Até lá o agente não usa a assinatura (a chave de API de reserva, se houver, segue atendendo). Nenhum arquivo a editar.
- **A rota global do webhook do WhatsApp só atende a rede interna da stack** Só para quem roda o WAHA em OUTRO servidor entregando na rota global pelo domínio do CRM: aponte o webhook para `https://<seu-domínio>/api/v1/webhooks/waha/<token-do-canal>` (passo a passo em `docs/runbooks/waha-hostgator.md`). Quem usa o WAHA da stack não faz nada.

**v1.77.0**

- **O agente começa a responder mais cedo — as leituras do turno que não dependem umas das outras correm juntas** As leituras antes de chamar o modelo caem de 16 idas ao banco em série para 5, com até 4 em paralelo por turno. No pico, elas podem esperar pelas 10 conexões padrão (`DB_POOL_MAX`).

- **A tela "Uso de IA" passa a contar o período inteiro e separa chamadas de turnos do agente** Acima de mil chamadas no período a tela somava só as primeiras mil; agora a conta é inteira. "Atendimentos com IA" vira "Chamadas de IA", e entram os cartões "Turnos do agente" e "Taxa de cache". O orçamento do mês não mudou. A função de banco vem na atualização.

- **A resposta do agente começa mais cedo — a mensagem que chega não espera mais a fila de eventos de todas as empresas** Com o `worker` de pé (o padrão), o recebimento pede o turno do agente antes de drenar a fila; notificações e automações de mensagem recebida podem chegar alguns segundos depois. Para o comportamento antigo, grave `EVENT_LOG_WORKER_DRAINS=false` no `.env` e reinicie o app.

- **O envio pelo WhatsApp para de perguntar ao WAHA, a cada mensagem, se o número existe** A resposta positiva fica guardada por 10 minutos por conexão. Se o número de um cliente mudar de grafia, o sistema pode levar esses 10 minutos para perceber.
