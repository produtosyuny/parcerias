# Painel de Parcerias

Versão estática (multi-arquivo) do Painel, pronta para hospedar no GitHub Pages.

## Estrutura

```
index.html          a página em si (estrutura/HTML)
css/styles.css       todo o visual — identidade institucional Yuny (creme/dourado/tinta, Satoshi+DM Sans, gráficos)
js/db-local.js        "banco de dados" temporário, guardado no navegador (localStorage) — modo de teste
js/db-sheets.js        liga o Painel na planilha Google Sheets via Apps Script — é o que está em uso hoje
js/app.js              toda a lógica do painel (formulário, gráficos, filtros, VGV...)
data/config.json      lista de estoques/lançamentos, metas padrão e a conexão com a planilha
assets/yuny-logo.png   logo da Yuny usada no cabeçalho (extraída do repo do Tabelão comercial)
Code.gs                código pra colar no Apps Script da planilha (não faz parte do site em si)
```

### Identidade visual

O Painel segue a mesma paleta/tipografia usada no site da Yuny, no Portal
Parcerias e no Tabelão comercial: fundo creme (`#f7f4f0`), tinta quase-preta
(`#1a1612`) e um único dourado de destaque (`#a07840`/`#86622f`), com cantos
retos e rótulos em caixa alta. Os tokens de cor ficam todos no topo de
`css/styles.css` (bloco `:root`) — pra ajustar algo da marca (ex: o tom do
dourado), basta mexer ali, sem precisar tocar no resto do CSS. As fontes
(Satoshi para títulos, DM Sans para o corpo) vêm de CDN no `index.html`; se o
CDN da Satoshi estiver fora do ar, o navegador usa DM Sans automaticamente
como alternativa — nada quebra.

Hoje o Painel só tem o tema claro institucional (sem alternância escura),
por ser mais fiel ao material de marca existente.

### Aba "Resumo" (visão do Diretor)

Pensada pra responder rápido o que normalmente é perguntado por quem está
acima do Diretor de Parcerias: qual produto se destacou, qual gerente liderou
visitas, qual liderou treinamento, como estão as propostas, e quem precisa de
atenção. Tudo calculado direto dos registros do período (sempre o time
inteiro, sem filtro de gerente/estoque) — nenhum número é digitado à mão.

Os alertas por gerente disparam em duas situações, sempre comparando com a
média do próprio time no período:

1. O gerente teve bastante atividade (visitas + treinamentos acima da média),
   mas nenhuma proposta saiu ainda.
2. Um pilar dele está zerado enquanto outro pilar dele está acima da média do
   time (ex.: muita visita, nenhum treinamento). Se ninguém do time teve
   aquele pilar no período, não conta como falha de um gerente específico —
   só dispara quando é algo que os colegas estão fazendo e ele não.

No fim da aba tem um bloco de texto pronto (com botão "Copiar texto") já no
formato de mensagem, pra colar direto numa conversa — a mesma ideia de
mandar o resumo da semana por WhatsApp, só que sem precisar montar nada na
mão toda vez.

### Aba "Individual" (visão do Diretor)

Pensada pra análise de um gerente só por vez — base pra 1:1, decidir quem
precisa de coaching, ou levar pro Meyer o desempenho individual de alguém.
Escolhe o gerente e o período num filtro só; tudo abaixo recalcula na hora:

- **VGV no período** do gerente escolhido (igual ao hero que ele já vê na
  própria visão, só que o Diretor consegue olhar de qualquer um).
- **Totais dos 4 pilares**, cada um com a "Média do time" no mesmo período
  logo embaixo do número — pra comparar sem precisar fazer conta de cabeça.
  Usei o número bruto da média (não um %), de propósito: com números pequenos
  um "+300%" exagera uma diferença de 1 registro pra 4, e isso confunde mais
  do que ajuda.
- **Tendência — últimas 8 semanas**: ao contrário do resto da aba, esse
  gráfico não segue o filtro de período de cima — mostra sempre as últimas 8
  semanas fechadas, pra responder "ele está melhorando, piorando ou estável?"
  sem precisar ficar trocando o período toda hora.
- **Funil de conversão** pessoal: Visitas+Treinamentos → Propostas → Vendas,
  com a taxa de conversão entre cada etapa.
- **Corretores dele**: contagem (igual à aba Corretores, sem dado sensível) e
  um botão "Ver lista completa" que já leva pra aba Corretores com o filtro
  por esse gerente aplicado.

### Aba "Produtos" (visão do Diretor)

Mesma ideia da aba Resumo — time inteiro, sem filtro de gerente — só que
agrupado por produto/lançamento em vez de por gerente: uma tabela com os
4 pilares (Visitas/Treinamentos/Propostas/Vendas) lado a lado, por produto.
Pensada pra substituir o relatório que antes era preenchido à mão (aquela
planilha de papel do Quaddra Jesuíno). Todo produto cadastrado em
`data/config.json` aparece na tabela, mesmo com zero atividade no período
— isso também é informação (ninguém foi lá ainda). O que não tem estoque
definido cai numa linha "Sem estoque/lançamento" no fim.

### Proposta → Venda: vincular pra não contar "potencial" em dobro

Antes, "Proposta" e "Venda" eram dois registros totalmente soltos — quando
uma proposta fechava, o gerente lançava uma Venda nova, e a proposta
continuava contando pra sempre como "potencial em propostas", mesmo já
tendo virado venda de verdade.

Agora, ao registrar uma **Venda**, aparece um campo opcional "Isso veio de
uma proposta já registrada?" com a lista das propostas em aberto desse
gerente (data + parceiro + estoque + valor). Vinculando, aquela proposta
sai do cálculo de "Potencial em propostas abertas" em todo o Painel (Resumo,
Individual, Visão geral e a própria visão do gerente) — sem apagar nada:
a contagem de "N propostas no período" continua contando as duas, porque
isso é histórico (quantas propostas foram feitas), só o valor em R$ que
ainda está em aberto é que desconta.

É opcional de propósito — se o gerente esquecer de vincular, ou se a
proposta nunca tinha sido lançada no Painel, nada quebra: só continua
contando como "em aberto" até alguém linkar.

**Passo manual obrigatório**: isso depende de uma coluna nova na planilha
(coluna L, "convertida de proposta"), então além de subir os arquivos do
site, você precisa colar o `Code.gs` atualizado no Apps Script de novo e
reimplantar como "Nova versão" (mesmo passo a passo de sempre, descrito mais
abaixo) — sem isso, o campo aparece na tela mas o vínculo não é salvo de
verdade. Não precisa criar a coluna L na planilha manualmente; o Apps Script
escreve nela direto.

### Botão "Exportar imagem"

Fica no cabeçalho, do lado do "Sair", e funciona em qualquer aba aberta (não
só no Resumo) — tanto na visão do gerente quanto na do diretor. Ele tira uma
espécie de "print" por código de tudo que está na aba atual, mesmo a parte
que só apareceria rolando a tela, e baixa como um arquivo `.png` — pra não
precisar mais printar a tela na mão pra mandar pro WhatsApp.

Por baixo dos panos usa uma biblioteca de terceiros (html2canvas), carregada
de um CDN público (cdnjs) — então depende de internet; sem conexão, aparece
um aviso pedindo pra verificar a internet e tentar de novo, em vez de travar.
Vale testar depois de subir, porque não deu pra testar esse botão 100% aqui
no meu ambiente (um bloqueio de rede específico daqui, não do seu site) —
me chama se algum gráfico sair cortado ou estranho na imagem exportada.

## Como o Painel fala com a planilha (Google Sheets)

O Painel hoje guarda tudo na planilha **registro_parcerias** do Google Drive, através de
um "Apps Script" publicado como Web App — um pequeno programa que vive dentro da própria
planilha e recebe pedidos do navegador (criar gerente, registrar uma visita/venda,
atualizar metas...). Isso é feito pelo arquivo `js/db-sheets.js`.

### Passo a passo pra ativar (só precisa fazer uma vez)

1. Abra a planilha **registro_parcerias** no Google Drive.
2. Menu **Extensões → Apps Script**.
3. Apague o que estiver lá e cole todo o conteúdo do arquivo `Code.gs` (está junto com
   estes arquivos do Painel).
4. Salve (ícone de disquete).
5. **Implantar → Nova implantação → tipo "App da Web"**.
6. "Executar como": **Eu**. "Quem pode acessar": **Qualquer pessoa**.
7. Clique em Implantar e autorize quando o Google pedir (é o seu script acessando a sua
   própria planilha).
8. Copie a URL que aparece (termina em `/exec`).
9. Abra `data/config.json` e cole essa URL no campo `"sheetsWebAppUrl"`. Não precisa tocar
   no `"sheetsToken"` — ele já está igual ao que está em `Code.gs`.

Pronto: a partir daí, o que qualquer gerente registrar no Painel aparece na planilha (e
no Dashboard dela) em poucos segundos, e o Painel também lê a planilha — então os dados
são os mesmos pra todo mundo, em qualquer computador/celular.

Se um dia precisar alterar o `Code.gs`, repita os passos 5–8 escolhendo **Gerenciar
implantações → editar a implantação existente → Nova versão**, pra manter a mesma URL em
vez de gerar uma nova (senão precisaria colar uma URL nova no `config.json` de novo).

### ⚠️ Sobre segurança

O Web App usa um "token" simples (já vem preenchido em `Code.gs` e em `config.json`) só
pra dificultar que alguém que ache a URL por acaso consiga usá-la sem esforço nenhum —
não é uma senha forte de verdade. E as senhas de login do Painel (diretor/gerentes) ficam
em texto puro na aba "Login" da planilha. Pra esse uso interno, pequeno e de time, isso é
uma troca razoável — mas não reuse ali uma senha importante de verdade.

### Corretores do Portal Parcerias

O Portal Parcerias (onde o corretor se cadastra sozinho) grava tudo numa planilha
**separada**, chamada "Cadastros do Portal Parcerias (PRIVADA)". O `Code.gs` abre essa
outra planilha pelo ID (constante `SPREADSHEET_ID_CADASTROS`, no topo do arquivo) e casa
o campo "Gerente escolhido" com o nome de cada gerente cadastrado na aba Login, pra cada
um ver só os corretores que o escolheram. Se o texto que o corretor digita/seleciona no
Portal não bater com nenhum gerente (ex.: "Não tenho gerente", ou um nome com erro de
digitação), o corretor aparece pro diretor como "Não vinculado a um gerente" — não some,
só não cai na lista de nenhum gerente específico.

Por segurança, só uma parte dos campos chega ao Painel: nome, CRECI e status de
validação, se atua como autônomo ou por imobiliária, WhatsApp, e-mail e data de
cadastro. **CPF, CNPJ e a senha (hash) do corretor nunca saem da planilha de
cadastros** — o endpoint do Web App é protegido só por um token simples (veja a seção
de segurança acima), então é melhor manter esses dados sensíveis de fora dele. Se um
dia precisar do CPF dentro do Painel, dá pra adicionar, mas vale pensar bem antes.

Se o ID dessa planilha de cadastros mudar (por exemplo, se o Portal passar a gravar em
outro lugar), é só atualizar o valor de `SPREADSHEET_ID_CADASTROS` no `Code.gs` e
reimplantar como Nova versão.

### Voltar ao modo de teste (sem planilha)

Se quiser testar alguma mudança no Painel sem afetar a planilha real, troque em
`index.html` a linha `<script src="js/db-sheets.js"></script>` de volta para
`<script src="js/db-local.js"></script>`. Nesse modo os dados ficam só no navegador,
como antes.

## Como testar no seu computador antes de subir

Não dá para simplesmente dar duplo-clique no `index.html` — o navegador bloqueia a
leitura do `data/config.json` quando a página é aberta como arquivo local (`file://`).
Isso faz o painel funcionar com estoques padrão "de fábrica" só até você rodar um
servidor local, mesmo que pequeno. O jeito mais simples, com Python (que você já tem,
já que estamos usando ele aqui):

1. Abra um terminal dentro da pasta `painel-parcerias`.
2. Rode: `python3 -m http.server 8000`
3. Abra no navegador: `http://localhost:8000`

Para parar o servidor depois, volte ao terminal e aperte `Ctrl+C`.

## Como publicar no GitHub Pages

1. Crie um repositório novo no GitHub (pode ser público ou privado, mas o GitHub Pages
   gratuito exige público, a menos que você tenha um plano pago).
2. Suba estes 5 itens (`index.html`, `css/`, `js/`, `data/`, este `README.md`) para a
   raiz do repositório — pelo site do GitHub mesmo (botão "Add file" → "Upload files")
   ou por `git push`, o que for mais confortável.
3. No repositório, vá em **Settings → Pages**.
4. Em "Source", escolha a branch `main` (ou a que você usou) e a pasta `/ (root)`.
5. Salve. Em alguns minutos o GitHub mostra o link público (algo como
   `https://seu-usuario.github.io/nome-do-repositorio/`).

Esse link já serve a página corretamente via HTTPS (não é `file://`), então o
`data/config.json` carrega normalmente.

### Depois de subir uma atualização e algo não aparecer

O `index.html` tem um link pro `css/styles.css` e os `<script>` do `js/` com
um `?v=AAAAMMDD` no fim (ex.: `js/app.js?v=20261123`). Isso existe porque o
navegador (e às vezes o próprio GitHub Pages) guarda esses arquivos em cache
por um tempo — sem esse "carimbo" de versão, dava pra subir um `js/app.js`
novo e o navegador continuar rodando o antigo escondido por trás, mesmo o
`index.html` sendo o mais recente (sintoma clássico: aba nova aparece no
menu, mas o conteúdo dela nunca carrega — só o texto fixo da tela). A partir
de agora, toda vez que eu mexer em `css/styles.css` ou `js/app.js`, também
atualizo esse número — então um simples recarregar a página já busca a
versão certa, sem precisar limpar cache ou usar aba anônima.

## O que editar sem mexer em código

Abra `data/config.json`: a lista `estoques` e os valores de `metasDefault`
(plantão/visita/apresentação da semana) podem ser alterados ali diretamente. O resto
(tipos de ação, pilares, lógica de VGV) está mais amarrado à lógica do painel e por isso
continua dentro de `js/app.js`/`index.html` por enquanto.
