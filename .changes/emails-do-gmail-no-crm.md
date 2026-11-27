---
impacto: capacidade_nova
secao: adicionado
titulo: E-mails do Gmail dos sócios no CRM, só leitura, ligados ao contato e ao negócio
---

Nova tela **E-mails** (só para administradores das organizações listadas em `GMAIL_INTAKE_ORG_IDS`). Cada sócio conecta o próprio Gmail com a permissão de só ler (`gmail.readonly`); só as caixas listadas em `GMAIL_INTAKE_ACCOUNTS` são aceitas. De 5 em 5 minutos o CRM lê os e-mails novos (na primeira vez, os últimos 14 dias), deixa de fora chats, spam, lixeira, promoções, redes sociais, fóruns e e-mails só entre a própria empresa, e liga cada e-mail ao contato cujo e-mail é o do cliente; contato criado depois também passa a ver os e-mails. A tela mostra as conversas dos últimos 30 dias com o contato, o negócio aberto e o link para abrir no Gmail; newsletters e avisos automáticos ficam de fora da lista. Nada é enviado, apagado ou marcado no Gmail. Na anonimização (LGPD) os e-mails da pessoa são apagados, e a cópia do titular os entrega. Desligado sem as duas variáveis: nenhuma consulta é feita.
