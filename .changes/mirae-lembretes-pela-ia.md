---
impacto: capacidade_nova
secao: adicionado
titulo: Lembretes do Mirae viram mensagem escrita pela assistente
---

O Mirae pode pedir ao CRM uma mensagem para a aluna a partir de um lembrete da agenda: a confirmação da avaliação inicial ou da primeira aula, um dia antes, ou um lembrete de "mensagem no WhatsApp" da equipe. A assistente escreve o texto com as próprias palavras, a partir do pedido da equipe e da conversa; nada sai de texto pronto.

Por padrão a mensagem vira um rascunho da assistente na conversa, que alguém da equipe aprova, edita ou descarta. A organização pode escolher que as confirmações saiam sozinhas: elas passam pelas mesmas regras de qualquer mensagem da assistente (horário de envio, ritmo, mensagens repetidas, opt-out, atendimento humano), e fora do horário esperam a próxima abertura. A assistente não manda nada quando a conversa mostra que a pessoa já confirmou, pediu para não receber mensagens ou mudou o agendamento. Contato bloqueado nunca recebe; quem tem um retorno da assistente já marcado também não recebe a segunda mensagem.

Para ligar o envio automático numa organização, quem opera a instalação grava `organizations.settings.mirae_reminder_delivery = "auto"` (`"draft"` é o padrão; `"off"` desliga).
