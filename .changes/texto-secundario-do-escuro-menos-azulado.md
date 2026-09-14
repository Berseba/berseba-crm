---
impacto: nada_mudou
secao: corrigido
titulo: Texto secundário do tema escuro fica um grau menos azulado
---

No tema escuro, `--color-text-muted` (e o `--color-neutral-300` que é o mesmo
pixel) passa de `#9ba6b0` para `#9da6ad`: mesma luminosidade, croma OKLab
baixada de 0,0192 para 0,0144 — a do stop vizinho da própria rampa. A distância
entre as duas cores é ΔE 0,0049, abaixo do que o olho distingue numa área de
texto; o contraste com o fundo continua 7,6:1.

Por que a mudança existe: o accent do produto passou a ser o azul-petróleo, e
os neutros petróleo têm o MESMO matiz que ele (245-248°). Medido com
`separacaoDoNeutro` (lib/branding/contraste.ts), o accent em uso no tema escuro
ficava a 0,0485 do neutro do mesmo grau, abaixo do piso de 0,05 que o produto
declara para "o accent ainda marca alguma coisa". Com o ajuste, 0,0503.

Nada a fazer: quem tem cor de marca configurada não é afetado, e quem não tem
recebe a cor nova no próximo `update.sh`, junto com o resto do tema.
