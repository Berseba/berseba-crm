---
impacto: nada_mudou
secao: corrigido
titulo: "Cancelar" sozinho não bloqueia mais o contato, e a atendente sempre consegue responder
---

Quando o cliente mandava só a palavra "Cancelar" (por exemplo, no botão de cancelar horário de um lembrete de confirmação), o sistema entendia que ele não queria mais receber mensagens: bloqueava o contato, calava a IA e travava a resposta da atendente, que via "envio de mensagens desabilitado". Agora "Cancelar" sozinho é tratado como uma mensagem comum; continuam bloqueando os pedidos claros, como "parar", "sair", "stop", "cancelar inscrição" e "quero cancelar as mensagens". E, mesmo com o contato bloqueado, a atendente pode responder pelo CRM: o bloqueio impede apenas a IA, as automações, as campanhas e os modelos de mensagem, e a conversa mostra um aviso. Contatos que já foram bloqueados por "Cancelar" continuam bloqueados até um administrador desbloqueá-los na ficha do contato.
