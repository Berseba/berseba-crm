# BERSEBA.md — o que este repositório muda em relação ao fornecedor

Este repositório é um fork enxuto do [DeskcommCRM](https://github.com/melgarafael/DeskcommCRM)
(MIT), mantido pela Berseba para o CRM em `crm.grupoberseba.com.br`. O `main` acompanha a
última release do fornecedor mais **cinco** commits nossos, listados abaixo. Tudo o mais é
do fornecedor e não se edita aqui.

## Customizações mantidas no `main`

| O quê | Por quê | Onde mexe |
|---|---|---|
| **Freios clínicos** — urgência médica relatada pelo contato vai para uma pessoa na hora (com orientação fixa: 192/SAMU); a resposta da IA é vetada se afirmar diagnóstico, prescrever ou prometer cura | Clínica FitVision atende pacientes pelo WhatsApp; o fornecedor só tem sinal genérico de urgência para priorizar alerta, não handoff nem veto | `lib/agent-engine/guardrails/escopo-clinico.ts`, `lib/agent-engine/guardrails/camadas-da-org.ts` (`lerNichoDaOrg`), `lib/ai/handoff/{triggers,regex}.ts`, `lib/escalacao/aviso-ao-lead.ts`, `lib/agent-engine/agent/inbound-turn.ts`, `lib/agent-engine/guardrails/before-send.ts` |
| **Nicho da organização** — a tela em Configurações › Segurança que escolhe o nicho; `saude` liga os freios acima | Configuração antes de código: o nicho vive em `organizations.settings.nicho`, sem migration | `lib/organizacoes/nicho.ts`, `app/api/v1/settings/nicho/route.ts`, `app/app/settings/security/{page,_client}.tsx`, `lib/audit/actions.ts` (`org.nicho_changed`) |
| **Espanhol** dos textos do nicho | O gate `i18n-espanhol-cobre-a-tela` exige | `lib/i18n/dicionario.ts` |
| **Imagens e repositório da Berseba** — `ghcr.io/berseba/*` e `github.com/berseba/berseba-crm` | O kit e o compose precisam puxar o que o nosso CI publica | `hostgator-setup-kit/{_common,install,comecar,diagnostico}.sh`, `docker-compose.prod.yml`, `.env.hostgator.example`, `Dockerfile*` (label de origem), `tests/unit/_identidade-deste-repo.ts` |
| **Worker com 1 GB** e heap do Node em 768 MB | Com 512 MB o worker reiniciava a cada ~10 min na VPS | `docker-compose.prod.yml`, serviço `worker` |

Qualquer arquivo desta tabela é candidato a conflito quando o fornecedor é sincronizado.
Ao resolver, a regra é: o lado do fornecedor vence, e o nosso trecho entra **ao lado**, sem
reescrever o dele.

## O que ficou de fora (e onde está guardado)

Branches `arquivo/*` no GitHub, todas a partir do ponto comum com o fornecedor (`53428145bb`,
release 1.20.0). Não recebem manutenção.

| Branch | Conteúdo |
|---|---|
| `arquivo/samuel-v1.20.3` (branch e tag) | O `main` inteiro do fork anterior, tal como rodou em produção até a troca |
| `arquivo/modo-sombra` | Modo sombra por organização e por canal (a IA sugere, nunca envia). Ninguém usava |
| `arquivo/sugestao-bolha` | Sugestão da IA como bolha no fio da conversa |
| `arquivo/tema-jo-os` | Tema visual do Jo OS. Será substituído por um tema Berseba, feito por configuração de marca |

## Regras de ouro

1. **Configuração antes de código.** Se dá para resolver em `organizations.settings`, marca
   própria ou variável de ambiente, não se escreve código. Cada linha nossa é uma linha que
   pode conflitar a cada sincronização.
2. **Só a vitrine muda.** Dono das imagens, URL do repositório, textos. **Nunca** renomear
   identificador interno: nomes de imagem (`deskcommcrm`, `deskcomm-worker`…), cookies,
   pastas, tabelas. Cada um vira conflito eterno.
3. **Não editar o `README.md` do fornecedor** (nem `CLAUDE.md`, `AGENTS.md`, `CONTRIBUTING.md`).
   O que é nosso fica aqui.
4. **Nunca fazer build na VPS.** Commit → PR → merge → o CI publica a imagem → a VPS puxa
   pelo `update.sh`. Ver `docs/doctrine/packaging.md`.
5. **Toda mudança de comportamento traz o seu fragmento em `.changes/`** com o efeito no
   operador (`nada_mudou` / `capacidade_nova` / `exige_acao`). Ver `docs/doctrine/versionamento.md`.
6. **Nunca importar as tags do fornecedor.** O remote `fornecedor` é adicionado com
   `--no-tags`; as tags `v*` deste repositório são só as nossas.
