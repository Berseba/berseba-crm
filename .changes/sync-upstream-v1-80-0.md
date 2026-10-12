---
impacto: exige_acao
secao: alterado
titulo: Sincronização com o DeskcommCRM v1.80.0 (vinha da v1.75.0)
---

O produto passa a incluir tudo o que o fornecedor lançou entre a v1.75.0 e a v1.80.0. As notas de cada versão estão nas releases dele:

- [v1.80.0](https://github.com/melgarafael/DeskcommCRM/releases/tag/v1.80.0)
- [v1.79.0](https://github.com/melgarafael/DeskcommCRM/releases/tag/v1.79.0)
- [v1.78.0](https://github.com/melgarafael/DeskcommCRM/releases/tag/v1.78.0)
- [v1.77.0](https://github.com/melgarafael/DeskcommCRM/releases/tag/v1.77.0)
- [v1.76.0](https://github.com/melgarafael/DeskcommCRM/releases/tag/v1.76.0)

## Requer atenção

O fornecedor pediu ação do operador nestas versões — leia antes de atualizar:

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
