---
impacto: exige_acao
secao: alterado
titulo: As imagens e o repositório passam a ser os da Berseba
---

O kit de instalação, o `docker-compose.prod.yml` e o `.env` de exemplo passam
a apontar para `ghcr.io/berseba/*` e para `github.com/berseba/berseba-crm`,
em vez do fornecedor (`melgarafael/DeskcommCRM`). Os nomes das imagens
(`deskcommcrm`, `deskcomm-worker`, `deskcomm-scheduler`,
`deskcomm-voice-agent`) não mudam: só o dono muda.

## Requer atenção

Instalação que hoje aponta para outro dono de imagem (`ghcr.io/samuelnishioka`
ou `ghcr.io/melgarafael`) precisa, uma vez, trocar no `.env` as variáveis
`APP_IMAGE`, `WORKER_IMAGE` e `SCHEDULER_IMAGE` para `ghcr.io/berseba/...` e
o remoto `origin` do clone para `https://github.com/berseba/berseba-crm.git`,
antes de rodar o `update.sh`. Faça com backup e numa janela de baixo uso.
