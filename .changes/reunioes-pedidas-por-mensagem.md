---
impacto: capacidade_nova
secao: adicionado
titulo: Reunião pedida ou confirmada por mensagem vira proposta para criar na agenda com um clique
---

Nas organizações listadas em `MEETING_DETECTION_ORG_IDS`, de 5 em 5 minutos o CRM lê as mensagens novas dos clientes (e-mails recebidos e WhatsApp, últimos 3 dias) que falam de reunião e pergunta ao modelo padrão da organização se o cliente pede uma reunião ou confirma um horário, e para quando. Só as mensagens com palavras de reunião vão ao modelo (no máximo 20 por rodada), e cada chamada entra no orçamento e no registro de custo de IA da organização. A tela **E-mails** ganha a seção **Reuniões para confirmar**: o sócio confere e clica em **Criar na agenda** (vira um compromisso dele na Agenda do CRM, com o contato, e vai para o Google Agenda dele pela sincronização que já existe) ou **Descartar**. Nada é marcado sozinho. Mensagem em que o modelo não achou reunião fica registrada sem texto, para não ser lida de novo. Na anonimização (LGPD) as propostas da pessoa são apagadas, e a cópia do titular as entrega.
