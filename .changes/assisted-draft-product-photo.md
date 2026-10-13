---
impacto: capacidade_nova
secao: adicionado
titulo: No modo Assistido, a sugestão de resposta pode levar a foto do produto
---

Quando o agente sugere uma resposta apresentando um produto do catálogo, a sugestão mostra a miniatura da foto do produto. Ao clicar em "Aprovar e enviar", o cliente recebe a foto com o texto aprovado (inclusive o editado) como legenda — o mesmo envio que o modo autônomo já fazia. Se o produto foi desativado ou removido do catálogo, nada é enviado e a sugestão fica marcada como falha. A legenda aceita até 1.024 caracteres; acima disso, o botão de aprovar fica bloqueado até o texto ser encurtado. A atualização acrescenta uma coluna ao banco e é aplicada sozinha pelo `update.sh`.
