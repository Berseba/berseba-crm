---
impacto: exige_acao
secao: alterado
titulo: O kit de instalação e as imagens publicadas agora são deste fork
---

O kit self-host (`hostgator-setup-kit/`) e o compose de produção apontavam para
`ghcr.io/melgarafael` e para o repositório `melgarafael/DeskcommCRM`, que é o
projeto upstream. Quem instala a partir deste fork puxava (ou tentava puxar)
imagens e código que não são os publicados aqui.

Agora `IMG_NS`, os defaults de `docker-compose.prod.yml` e `.env.hostgator.example`,
e as URLs de clone (`install.sh`, `comecar.sh`, `_common.sh`, e os labels de
origem dos três Dockerfiles) apontam para `ghcr.io/samuelnishioka` e para
`github.com/samuelnishioka/jo-atende-crm`.

## Requer atenção

Este repositório é PRIVADO, diferente do upstream. Antes de instalar ou
atualizar a partir dele numa VPS:

- **Clone:** o `install.sh` faz `git clone --depth 1 "$REPO_URL"` sobre HTTPS —
  contra um repositório privado isso pede autenticação interativa, que o
  script não tem como fornecer. É preciso configurar credencial na VPS antes
  de rodar o instalador: uma deploy key SSH read-only com `REPO_URL` trocado
  para `git@github.com:samuelnishioka/jo-atende-crm.git`, ou um token de
  acesso pessoal exportado via `GIT_ASKPASS`/credential helper mantendo a URL
  HTTPS. Nenhuma das duas foi aplicada neste PR — só o padrão HTTPS foi
  trocado de dono; a autenticação é passo manual do operador.
- **Imagens no GHCR:** pacotes novos nascem PRIVADOS. `ghcr_status()` (usada no
  pré-voo do kit) trata isso como pacote indisponível para pull anônimo — o
  `docker compose pull` de uma VPS sem credencial falha a operação inteira.
  Duas saídas possíveis, nenhuma aplicada automaticamente por este PR: tornar
  os três pacotes (`deskcommcrm`, `deskcomm-worker`, `deskcomm-scheduler`)
  públicos no GHCR, ou rodar `docker login ghcr.io` na VPS com um token
  read-only (`read:packages`) antes do install/update.
