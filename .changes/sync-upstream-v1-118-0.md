---
impacto: exige_acao
secao: alterado
titulo: Sincronização com o DeskcommCRM v1.118.0 (vinha da v1.102.0)
---

O produto passa a incluir tudo o que o fornecedor lançou entre a v1.102.0 e a v1.118.0. As notas de cada versão estão nas releases dele:

- [v1.118.0](https://github.com/melgarafael/DeskcommCRM/releases/tag/v1.118.0)
- [v1.117.0](https://github.com/melgarafael/DeskcommCRM/releases/tag/v1.117.0)
- [v1.116.0](https://github.com/melgarafael/DeskcommCRM/releases/tag/v1.116.0)
- [v1.115.0](https://github.com/melgarafael/DeskcommCRM/releases/tag/v1.115.0)
- [v1.114.0](https://github.com/melgarafael/DeskcommCRM/releases/tag/v1.114.0)
- [v1.113.0](https://github.com/melgarafael/DeskcommCRM/releases/tag/v1.113.0)
- [v1.112.0](https://github.com/melgarafael/DeskcommCRM/releases/tag/v1.112.0)
- [v1.111.0](https://github.com/melgarafael/DeskcommCRM/releases/tag/v1.111.0)
- [v1.110.0](https://github.com/melgarafael/DeskcommCRM/releases/tag/v1.110.0)
- [v1.109.0](https://github.com/melgarafael/DeskcommCRM/releases/tag/v1.109.0)
- [v1.108.0](https://github.com/melgarafael/DeskcommCRM/releases/tag/v1.108.0)
- [v1.107.0](https://github.com/melgarafael/DeskcommCRM/releases/tag/v1.107.0)
- [v1.106.0](https://github.com/melgarafael/DeskcommCRM/releases/tag/v1.106.0)
- [v1.105.0](https://github.com/melgarafael/DeskcommCRM/releases/tag/v1.105.0)
- [v1.104.0](https://github.com/melgarafael/DeskcommCRM/releases/tag/v1.104.0)
- [v1.103.0](https://github.com/melgarafael/DeskcommCRM/releases/tag/v1.103.0)

## Requer atenção

O fornecedor pediu ação do operador nestas versões — leia antes de atualizar:

**v1.118.0**

- **A IA só lê o campo personalizado que o funil marcou como legível** Campo personalizado que já existia, sem a marca, deixa de ir ao modelo até ser
  marcado. Ao atualizar, abra CRM → Ver tudo em CRM → Etapas do funil (seção
  "Preparar a venda") e, no fim de cada campo do negócio, marque "A IA pode ler
  este campo" nos campos que o agente pode usar no atendimento; os demais seguem
  só no card. Nada a instalar: a definição do campo mora no próprio funil.

  Contribuição de @webtecnica (#4684, #4669).

**v1.113.0**

- **Transferir a conversa leva o negócio aberto e devolve a conversa ao número em que o cliente falou** Negócios transferidos antes desta versão ficaram com quem saiu da conversa,
  porque a escrita era pulada em silêncio. Depois de atualizar, vale conferir os
  negócios abertos das conversas que trocaram de dono nas últimas semanas e
  reatribuir o responsável pelo próprio card, quando ele não for a pessoa que
  atende hoje. Não há nada a instalar nem a configurar: a correção do banco entra
  junto com a atualização.

  Contribuição de @webtecnica (#4530).

- **IA › Execuções e o Custo da IA voltam a mostrar os dados da organização** Rodar a atualização da instalação aplica a policy de leitura — é ela que devolve
  as execuções e o custo das chamadas que já estão gravadas. Não há nada a
  configurar nem a reinstalar, e nenhum dado é apagado. Se a tela continuar vazia
  depois de atualizar, confira em IA › Execuções se o filtro de período está
  apertado antes de abrir um chamado.

  Contribuição de @webtecnica (#4539).

- **Follow-up por nicho passa a casar também com a etiqueta que está no contato** Nada a fazer nas campanhas nem nos fluxos por nicho: eles passam a escolher o ramo certo sozinhos, inclusive com os cards criados antes da atualização. Vale conferir os fluxos que usam «não tem a etiqueta»: o contato marcado agora conta como etiquetado, e a negação deixa de valer para ele — que é o que a tela sempre descreveu.

  Contribuição de @webtecnica (#4644).

**v1.105.0**

- **Salvar outra configuração da instalação não reabre mais o cadastro fechado por SIGNUP_MODE** A atualização não corrige uma instalação que já foi reaberta assim. Se você usa `SIGNUP_MODE=so_convite` e alguma vez salvou o comportamento, o molde de IA ou os destinos internos, abra **Cadastro** no painel da instalação, confira a chave e ligue **Cadastro apenas por convite** de novo.
- **O follow-up automático escolhe o agente pelo número da conversa** Se a organização tem mais de um número, confira que quem atende cada fluxo de follow-up atende no número onde o fluxo deve rodar: publicado naquele número, ou membro/fallback do roteador ativo daquele número. Fluxo que antes disparava no número errado deixa de disparar, e o ajuste é publicar o agente no número certo, apontar o fluxo para o agente daquele número ou incluí-lo no roteador ativo.

**v1.104.0**

- **Condição de regra sobre as colunas de CPF responde só se estão preenchidas** Vale só para quem escreveu uma condição dessas com outro operador; sem isso, não há
  nada a fazer.

  - Regra que comparava o valor dessas colunas deixa de disparar. Para saber se a
    ficha tem CPF, use "está preenchido".
- **As respostas da API de contatos dizem só se há CPF** Vale só para quem integra com a API de contatos ou escreveu um modelo de mensagem
  com essas colunas; sem isso, não há nada a fazer.

  - Integração que lia `cpf_hash` para saber se a ficha tem CPF passa a ler `cpf_available`.
  - Integração que usava `cpf_hash` para localizar a ficha de uma pessoa passa a buscar
    com `GET /api/v1/contacts?search=` e os 11 dígitos do CPF.
  - Modelo de mensagem que citava `contact.cpf_hash` ou `contact.cpf_encrypted` sai com
    esse trecho em branco.
