# Finanças

App pessoal de controle financeiro para o celular. Ele puxa sozinho as contas, os cartões e os investimentos do **Nubank** e do **PicPay** via Open Finance (usando o [Meu Pluggy](https://meu.pluggy.ai), que é gratuito para uso pessoal). Tem três abas:

- **Resumo**: gastos do mês comparados com o mês anterior, saldo, faturas, gastos dos últimos 6 meses e as categorias onde você mais gasta
- **Gastos**: mês a mês, por categoria (toque numa categoria para ver as compras), maiores gastos e os lugares onde você mais gasta
- **Investimentos**: patrimônio, rendimento, evolução, distribuição por tipo e lista de aplicações. Dá pra adicionar investimentos manualmente se algum não vier pelo Open Finance.

## Como funciona

```
Meu Pluggy (atualiza seus bancos 1x/dia)
        │
GitHub Actions (3x/dia) ── lê os dados pela API da Pluggy
        │                   e criptografa com a sua senha (AES-256)
        ▼
GitHub Pages ── publica o app + data.enc.json (ilegível sem a senha)
        │
Celular ── você digita a senha uma vez e o app descriptografa no próprio aparelho
```

Nenhum dado financeiro vai para o repositório, nem para o histórico do git. O site público só tem o arquivo criptografado. Suas chaves da Pluggy ficam nos *Secrets* do GitHub.

Enquanto os segredos da Pluggy não estiverem configurados, o app mostra **dados de demonstração** (senha: `demo`).

## Configuração (uma vez só)

### 1. Ativar o GitHub Pages
No repositório, vá em **Settings → Pages → Build and deployment → Source** e escolha **GitHub Actions**.

### 2. Criar a aplicação na Pluggy
1. Crie uma conta em <https://dashboard.pluggy.ai>.
2. Em **Applications**, crie uma aplicação e copie o **Client ID** e o **Client Secret**.
3. Na personalização da aplicação (**Customization / Connectors**), adicione o conector **MeuPluggy**.

> Importante: só é possível conectar o Meu Pluggy enquanto o trial da conta da Pluggy estiver ativo. Faça os passos 2 e 3 em seguida.

### 3. Conectar seus bancos no Meu Pluggy
1. Entre em <https://meu.pluggy.ai> e conecte o **Nubank** e o **PicPay** pelo Open Finance. Se quiser os investimentos, autorize também o compartilhamento de investimentos.
2. Autorize cada banco para a sua aplicação. É o mesmo fluxo do [guia oficial](https://github.com/pluggyai/meu-pluggy): na sua aplicação, use o botão de demo/conectar e escolha **MeuPluggy**.
3. Copie o **Item ID** de cada conexão: menu de três pontinhos → **Copiar Item ID**.

### 4. Cadastrar os segredos no GitHub
Em **Settings → Secrets and variables → Actions → New repository secret**, crie:

| Nome | Valor |
|---|---|
| `APP_SENHA` | a senha que você vai digitar no app (use uma senha forte, ela protege seus dados) |
| `PLUGGY_CLIENT_ID` | Client ID da aplicação |
| `PLUGGY_CLIENT_SECRET` | Client Secret da aplicação |
| `PLUGGY_ITEM_IDS` | os Item IDs separados por vírgula, ex.: `id-do-nubank,id-do-picpay` |

### 5. Rodar e instalar
1. Em **Actions → Atualizar dados e publicar → Run workflow**.
2. Abra `https://<seu-usuario>.github.io/financas/` no celular e digite a senha.
3. Instale na tela inicial:
   - **Android (Chrome)**: menu ⋮ → *Adicionar à tela inicial*
   - **iPhone (Safari)**: Compartilhar → *Adicionar à Tela de Início*

## Dia a dia

- Os dados se atualizam sozinhos 3x por dia. Para atualizar na hora, rode o workflow manualmente (dá pra fazer pelo app do GitHub no celular).
- O botão de olho no topo esconde os valores (bom pra usar na rua).
- O gráfico de evolução dos investimentos vai se formando com o tempo: cada coleta guarda uma foto do patrimônio.
- Pagamento de fatura, transferências entre suas contas e aplicações/resgates não contam como gasto, para não contar a mesma despesa duas vezes.

## Estrutura

| Arquivo | O que é |
|---|---|
| `index.html`, `app.js`, `style.css` | o app (PWA, sem dependências) |
| `sw.js`, `manifest.webmanifest`, `icons/` | instalação no celular |
| `scripts/coletar.mjs` | coleta na Pluggy, categoriza e criptografa |
| `.github/workflows/atualizar.yml` | agenda a coleta e publica no Pages |

Para testar localmente: `node scripts/coletar.mjs && cp -r index.html app.js style.css sw.js manifest.webmanifest icons _site/ && npx serve _site` (senha `demo`).
