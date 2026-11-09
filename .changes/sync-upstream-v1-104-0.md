---
impacto: exige_acao
secao: alterado
titulo: Sincronização com o DeskcommCRM v1.104.0 (vinha da v1.102.0)
---

O produto passa a incluir tudo o que o fornecedor lançou entre a v1.102.0 e a v1.104.0. As notas de cada versão estão nas releases dele:

- [v1.104.0](https://github.com/melgarafael/DeskcommCRM/releases/tag/v1.104.0)
- [v1.103.0](https://github.com/melgarafael/DeskcommCRM/releases/tag/v1.103.0)

## Requer atenção

O fornecedor pediu ação do operador nestas versões — leia antes de atualizar:

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
