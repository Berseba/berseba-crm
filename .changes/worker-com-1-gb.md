---
impacto: nada_mudou
secao: corrigido
titulo: O worker deixa de reiniciar a cada dez minutos por falta de memória
---

O serviço `worker` (o runtime dos agentes de IA) tinha teto de 512 MB e um
heap padrão do Node maior do que isso: ele crescia, estourava o teto e era
morto e reiniciado a cada ~10 minutos (863 reinícios medidos numa VPS de
7,9 GB, com heap de ~252 MB). O teto passa a 1 GB e o heap do Node fica
limitado a 768 MB, abaixo do teto, para o próprio Node coletar lixo antes de
o contêiner ser morto. Nada a fazer: o `update.sh` aplica o compose novo.
