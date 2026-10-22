---
impacto: nada_mudou
secao: corrigido
titulo: A caixa de entrada não trava mais para carregar e contar as conversas
---

A lista de conversas e os contadores das abas (Fila, Automático, Todas) ficavam lentos e às vezes não carregavam: o banco conferia, conversa por conversa, quem podia ver cada uma, e essa conferência custava caro. Por isso uma conversa assumida ou fechada demorava a sair da Fila. Agora a regra de quem vê o quê é calculada uma vez por consulta — a mesma regra, sem mudar o que cada pessoa enxerga — e a contagem que levava cerca de 4 segundos leva cerca de 20 milissegundos. As mensagens de uma conversa também abrem mais rápido pelo mesmo motivo.
