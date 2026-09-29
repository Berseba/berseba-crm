---
impacto: capacidade_nova
secao: adicionado
titulo: Relatório por etiqueta — volume, espera e desfecho de cada assunto no período
---

Quem opera agora pode perguntar à API **qual assunto ocupou a operação em um período e quanto tempo o cliente esperou**. `GET /api/v1/reports/tags` devolve, para cada etiqueta em uso, quantos atendimentos começaram no período, quantos ainda estão abertos e quantos foram encerrados, a espera média pela nossa resposta e a fatia de cada etiqueta sobre o total. A lista de etiquetas vem das que existem de fato nas conversas: uma etiqueta sem atendimento no período aparece com zero em vez de sumir, e um período sem dado nenhum diz isso na resposta em vez de devolver uma tabela de zeros. O pedido aceita `de`, `ate` (datas válidas, até 90 dias) e `tz`, porque a janela é contada no fuso de quem lê. Quando a janela tem mais conversas do que a leitura alcança, a resposta avisa que está cortada. É só leitura, sem migration e ainda sem tela: a tela vem depois. Contribuição de @webtecnica (#1888).
