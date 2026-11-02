# Painel de Parcerias

Versão estática (multi-arquivo) do Painel, pronta para hospedar no GitHub Pages.

## Estrutura

```
index.html          a página em si (estrutura/HTML)
css/styles.css       todo o visual (glass, cores da marca Yuny, gráficos)
js/db-local.js        "banco de dados" temporário, guardado no navegador (localStorage) — modo de teste
js/db-sheets.js        liga o Painel na planilha Google Sheets via Apps Script — é o que está em uso hoje
js/app.js              toda a lógica do painel (formulário, gráficos, filtros, VGV...)
data/config.json      lista de estoques/lançamentos, metas padrão e a conexão com a planilha
Code.gs                código pra colar no Apps Script da planilha (não faz parte do site em si)
```

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

## O que editar sem mexer em código

Abra `data/config.json`: a lista `estoques` e os valores de `metasDefault`
(plantão/visita/apresentação da semana) podem ser alterados ali diretamente. O resto
(tipos de ação, pilares, lógica de VGV) está mais amarrado à lógica do painel e por isso
continua dentro de `js/app.js`/`index.html` por enquanto.
