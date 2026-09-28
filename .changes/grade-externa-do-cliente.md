---
impacto: capacidade_nova
secao: adicionado
titulo: A IA pode consultar a grade de turmas que o cliente mantém em outro sistema
---

Organizações que já mantêm a agenda de turmas num sistema próprio — um studio de
treino, uma escola, uma clínica com grade de horários fora daqui — podem deixar a
IA **ler** essa grade antes de oferecer horário a alguém. A capacidade nova aparece
em Configurações › Inteligência como "Ver vagas nas turmas do seu outro sistema".

**É só leitura.** Nada é marcado, alterado ou apagado no sistema do cliente: quem
confirma a turma do lado de lá continua sendo uma pessoa da equipe. A reserva
segue vivendo aqui.

**A modalidade é obrigatória em toda consulta.** A mesma sala comporta gente
diferente conforme a atividade, e uma grade costuma misturar turma de adulto,
turma infantil e aula de dança na mesma tela. Sem a modalidade, a IA ofereceria
o horário da turma errada para a pessoa errada.

**Falha não vira horário inventado.** Se a grade não responder, a IA avisa que
alguém da equipe confirma e retorna — ela não chuta um horário e não anuncia
lotação por conta própria. Vaga informada como zero é turma cheia; vaga que o
outro sistema não informou continua desconhecida, e nesses casos a IA oferece
pedindo confirmação.

**Nada muda para quem não configurar.** Sem configuração, a organização segue
com a agenda de casa como única fonte de horário, exatamente como antes.

A configuração é **por organização**, em `organizations.settings.agenda_externa`
— nunca por variável de ambiente. Numa instalação que atende várias empresas, uma
credencial de acesso no `.env` ficaria ao alcance do atendimento de todas elas.

O primeiro adaptador é o do Admin Fit. O transporte dele — como a grade é
efetivamente lida — ainda não está decidido, e enquanto não estiver a consulta
responde "indisponível" de propósito, em vez de devolver horário plausível.
