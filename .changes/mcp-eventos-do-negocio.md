---
impacto: capacidade_nova
secao: adicionado
titulo: MCP — filtro por etiqueta em crm_list_leads e a nova leitura crm_list_lead_events
---

A ferramenta `crm_list_leads` aceita `tag`: lista só os negócios que têm aquela etiqueta exata (por exemplo `plano-enterprise`). A nova ferramenta de leitura `crm_list_lead_events` recebe até 100 negócios e uma data e devolve, em ordem, quando cada um recebeu um toque (toque registrado ou WhatsApp enviado ao contato), quando o contato respondeu e quando uma reunião foi marcada, com o canal. Mensagens contam uma vez por negócio e por dia (a primeira). Não traz o texto das mensagens, nomes nem telefones, e só enxerga os negócios da organização do token. Na tela do agente de IA, ela faz parte do pacote "Passar para um humano"; dentro de uma conversa, o agente só vê os negócios do contato daquela conversa.
