# Flatt releases

Repositório público para distribuir instaladores, arquivos de atualização automática e notas de versão do Flatt.

O código-fonte é mantido separadamente. Este repositório não contém o código-fonte do aplicativo.

## Publicação

O app é compilado no repositório privado. Este repositório recebe somente os instaladores, blockmaps, manifests de atualização e notas de versão.

1. Compile com a identidade de produção do Flatt e uma versão semântica. Para testes use `X.Y.Z-beta.N`.
2. No repositório do app, execute `pnpm release:desktop --dir <artefatos> --version <versão> --notes <arquivo>`. O comando valida os arquivos, cria um draft e verifica o upload baixando os arquivos novamente.
3. Abra **Actions → Verify and publish release**, informe a tag do draft (por exemplo `v0.0.1-beta.1`) e execute com `publish=false` para verificar.
4. Depois da validação dos instaladores, execute novamente com `publish=true`. O workflow recusa releases já publicadas e versões inconsistentes.

Releases beta ficam marcadas como prerelease e não substituem a versão estável em latest. Usuários habilitam atualizações de prévia no Flatt para recebê-las. O produto separado “flatt preview” não utiliza esse fluxo.

As publicações usam somente a credencial temporária do GitHub Actions. O aplicativo instalado consulta as releases públicas sem login e sem token.

## Validação local

```sh
npm ci
npm test
node scripts/verify-release.mjs <diretório-de-artefatos> <versão>
```

## Estado inicial

Nenhum instalador de produção foi publicado. O primeiro alvo de validação é Windows x64. Uma atualização real exige dois instaladores: instalar a versão A, publicar a B e verificar download, reinício e preservação das configurações.

A compilação dos instaladores acontece separadamente. A assinatura de Windows e a assinatura/notarização de macOS precisam ser configuradas na máquina ou no runner de build.
