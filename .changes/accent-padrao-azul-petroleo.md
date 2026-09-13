---
impacto: capacidade_nova
secao: adicionado
titulo: Cor de marca padrão do produto passa a ser o azul-petróleo do Jo. OS
---

Quando nenhuma organização (nem a instalação) configurou uma cor própria em
Configurações › Marca, o botão primário e os outros papéis de accent (anel de
foco, seleção, links) deixam de nascer verde-sálvia e passam a nascer no
azul-petróleo do Jo. OS: `#1c2e3f` no tema claro, com o mesmo derivado
automático de contraste (`lib/branding/contraste.ts`) resolvendo o tema escuro.

Nada muda para quem já configurou uma cor — a fragmento anterior
("Tema padrão do produto passa a ser o do Jo OS") dizia que a cor de marca
continuava vinda só do banco; isto continua verdade para QUALQUER instalação
ou organização com cor própria configurada. O que muda é só o piso: o hex que
vale quando ninguém escolheu nada.

Botões e inputs também ganharam cantos um pouco mais arredondados
(`rounded-md` em vez de `rounded-sm`), para bater com o raio do Jo. OS.
