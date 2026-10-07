---
impacto: capacidade_nova
secao: alterado
titulo: Sincronização com o DeskcommCRM v1.75.0 (vinha da v1.62.0)
---

O que muda para quem opera a instalação:

- **A atualização deixa de parar no banco.** Ela travava com `ai_pricing_pkey` (um modelo de IA cadastrado em dois provedores) e com um falso alarme de "regras de isolamento ausentes" do módulo de honorários, que só existe quando é instalado.
- **A atualização confere antes de parar o sistema** (Docker respondendo e as imagens da versão publicadas) e, se algo falhar no meio, volta para a versão anterior. Vale a partir da próxima atualização depois desta.
- **O WhatsApp passa a assinar as entregas de mensagem.** O contêiner do WAHA é recriado nesta atualização: espere uma reconexão de alguns segundos. Nenhuma configuração precisa mudar.

O produto passa a incluir tudo o que o fornecedor lançou entre a v1.62.0 e a v1.75.0. As notas de cada versão estão nas releases dele:

- [v1.75.0](https://github.com/melgarafael/DeskcommCRM/releases/tag/v1.75.0)
- [v1.74.0](https://github.com/melgarafael/DeskcommCRM/releases/tag/v1.74.0)
- [v1.73.0](https://github.com/melgarafael/DeskcommCRM/releases/tag/v1.73.0)
- [v1.72.0](https://github.com/melgarafael/DeskcommCRM/releases/tag/v1.72.0)
- [v1.71.0](https://github.com/melgarafael/DeskcommCRM/releases/tag/v1.71.0)
- [v1.70.0](https://github.com/melgarafael/DeskcommCRM/releases/tag/v1.70.0)
- [v1.69.0](https://github.com/melgarafael/DeskcommCRM/releases/tag/v1.69.0)
- [v1.68.0](https://github.com/melgarafael/DeskcommCRM/releases/tag/v1.68.0)
- [v1.67.0](https://github.com/melgarafael/DeskcommCRM/releases/tag/v1.67.0)
- [v1.66.1](https://github.com/melgarafael/DeskcommCRM/releases/tag/v1.66.1)
- [v1.66.0](https://github.com/melgarafael/DeskcommCRM/releases/tag/v1.66.0)
- [v1.65.0](https://github.com/melgarafael/DeskcommCRM/releases/tag/v1.65.0)
- [v1.64.1](https://github.com/melgarafael/DeskcommCRM/releases/tag/v1.64.1)
- [v1.64.0](https://github.com/melgarafael/DeskcommCRM/releases/tag/v1.64.0)
- [v1.63.6](https://github.com/melgarafael/DeskcommCRM/releases/tag/v1.63.6)
- [v1.63.5](https://github.com/melgarafael/DeskcommCRM/releases/tag/v1.63.5)
- [v1.63.4](https://github.com/melgarafael/DeskcommCRM/releases/tag/v1.63.4)
- [v1.63.3](https://github.com/melgarafael/DeskcommCRM/releases/tag/v1.63.3)
- [v1.63.2](https://github.com/melgarafael/DeskcommCRM/releases/tag/v1.63.2)
- [v1.63.1](https://github.com/melgarafael/DeskcommCRM/releases/tag/v1.63.1)
- [v1.63.0](https://github.com/melgarafael/DeskcommCRM/releases/tag/v1.63.0)
