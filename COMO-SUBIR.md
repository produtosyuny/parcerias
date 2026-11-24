# Como subir a versão de 24/11 — passo a passo

São 3 partes. Faça **na ordem**, de preferência no computador, num momento em
que os gerentes não estejam lançando nada (leva uns 10 minutos). Entre a
parte 1 e a parte 2 o painel fica alguns minutos fora do ar: é normal.

---

## Parte 1 — Script da planilha do Painel (Code.gs)

1. Abra a planilha **registro_parcerias** no Google Drive.
2. Menu **Extensões → Apps Script**.
3. À esquerda, clique no arquivo **Código.gs** (ou Code.gs).
4. Apague todo o conteúdo e cole o arquivo **apps-script/Code.gs** deste pacote.
5. Clique no disquete (**Salvar**).
6. **Implantar → Gerenciar implantações** → clique no **lápis** → em Versão,
   escolha **Nova versão** → **Implantar**. (A URL continua a mesma.)
7. Se o Google pedir autorização, aceite.

### Relatórios automáticos (mesma tela)
8. Ainda no Apps Script, clique no **+** ao lado de "Arquivos" → **Script** →
   nome: `relatorios`.
9. Cole o arquivo **apps-script/relatorios.gs** e salve.
10. No topo, escolha a função **testarRelatorioSemanal** e clique em
    **Executar**. Autorize. Deve chegar um e-mail de teste no rlopes@yuny.com.br.
11. Gostou? Escolha a função **instalarGatilhos** e clique em **Executar**.
    Pronto: segunda 8h (resumo), dias úteis 18h (quem não registrou) e dia 1º
    (fechamento do mês) — tudo só para rlopes@yuny.com.br por enquanto.

## Parte 2 — Site do Painel (GitHub, repositório `parcerias`)

1. Abra github.com/produtosyuny/parcerias.
2. **Add file → Upload files**.
3. Arraste para lá, de dentro da pasta descompactada, **tudo**: `index.html`,
   `README.md`, `COMO-SUBIR.md` e as pastas `css`, `js`, `data`, `assets`,
   `apps-script`.
4. **Commit changes**. Em 1–2 minutos o site atualiza.
5. Abra produtosyuny.github.io/parcerias e entre com a sua senha.

**Importante:** todo mundo vai precisar entrar de novo uma vez (o login
mudou). Depois disso o navegador lembra por 30 dias.

**Recomendado:** como a lista de senhas ficou exposta na versão antiga, troque
a senha de cada gerente (e a sua) na aba **Gerentes** e mande a nova pra cada
um. Trocar a senha derruba o acesso antigo na hora.

## Parte 3 — Portal do Corretor (repositório `portalparcerias`)

Serve para saber por qual link cada corretor se cadastrou.

1. Abra a planilha **Cadastros do Portal Parcerias (PRIVADA)** → Extensões →
   Apps Script → cole o **apps-script/Codigo.gs** do pacote do Portal →
   Salvar → Implantar → Gerenciar implantações → lápis → Nova versão → Implantar.
2. Em github.com/produtosyuny/portalparcerias → Add file → Upload files →
   suba o `index.html` e a pasta `apps-script` do pacote do Portal → Commit.

Dica: em post de Instagram, use o link com `?origem=instagram`
(ex.: produtosyuny.github.io/portalparcerias/?origem=instagram). O painel
mostra de onde veio cada corretor.

---

## Se algo der errado

- **Painel mostra "Não foi possível conectar"**: a parte 1 (Nova versão do
  Code.gs) não foi publicada. Repita o passo 6.
- **Senha certa e não entra**: depois de 5 erros o login trava 15 minutos.
- **Quer voltar atrás**: no Apps Script, Gerenciar implantações → lápis →
  escolha a versão anterior. No GitHub, reenvie os arquivos antigos (estão em
  Downloads\painel-parcerias no seu notebook).
