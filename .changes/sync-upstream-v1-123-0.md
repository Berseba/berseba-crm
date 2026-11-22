---
impacto: exige_acao
secao: alterado
titulo: Sincronização com o DeskcommCRM v1.123.0 (vinha da v1.118.0)
---

O produto passa a incluir tudo o que o fornecedor lançou entre a v1.118.0 e a v1.123.0. As notas de cada versão estão nas releases dele:

- [v1.123.0](https://github.com/melgarafael/DeskcommCRM/releases/tag/v1.123.0)
- [v1.122.0](https://github.com/melgarafael/DeskcommCRM/releases/tag/v1.122.0)
- [v1.121.0](https://github.com/melgarafael/DeskcommCRM/releases/tag/v1.121.0)
- [v1.120.1](https://github.com/melgarafael/DeskcommCRM/releases/tag/v1.120.1)
- [v1.120.0](https://github.com/melgarafael/DeskcommCRM/releases/tag/v1.120.0)
- [v1.119.0](https://github.com/melgarafael/DeskcommCRM/releases/tag/v1.119.0)

## Requer atenção

O fornecedor pediu ação do operador nestas versões — leia antes de atualizar:

**v1.123.0**

- **SENTRY_DSN vazio deixa de ligar o Sentry do projeto; o aceite passa a ser o token comunidade** Quem já havia aceitado a telemetria tem `SENTRY_DSN=""` no `.env`, e vazio agora desliga. Rodar o `update.sh` (uma vez, como de costume) converte a chave para `SENTRY_DSN=comunidade` e o envio continua; quem não roda nada simplesmente para de enviar. Não descomente a linha da telemetria no `.env.hostgator.example`: chave vazia deixou de ser consentimento.
- **Na véspera e no dia do feriado nacional, o agente volta a marcar nos horários livres da Agenda** Desde a v1.100.0, o agente recusava marcar compromisso na véspera e no dia do feriado
  nacional. A partir desta versão, com a opção "Não atender em feriado nacional" desligada
  (o padrão), ele passa a oferecer os horários que aparecem livres na Agenda nesse dia. Se
  a sua empresa fecha em feriado nacional, antes de atualizar ligue essa opção no agente,
  junto de "Só atender em horário de funcionamento", ou bloqueie o dia na Agenda.

**v1.121.0**

- **API de serviços devolve código, e não frase, no motivo da recusa** Se a sua integração compara as frases de `error.details` ao cadastrar ou alterar serviços,
  passe a comparar os códigos. Quem usa só a tela do CRM não precisa fazer nada.
