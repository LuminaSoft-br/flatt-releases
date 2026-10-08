# Flatt releases

Repositório público para distribuir instaladores, arquivos de atualização automática e notas de versão do Flatt.

O código-fonte é mantido separadamente. Este repositório não contém o código-fonte do aplicativo.

## Publicação

O workflow manual **Release desktop** em `LuminaSoft-br/flatt-app` compila os cinco alvos nativos, valida e reúne os arquivos, cria um draft, verifica os bytes enviados e publica quando `publish=true`. Ele requer o secret `FLATT_RELEASES_TOKEN` no privado, restrito a este repositório com Contents read/write. `publish=false` prepara um draft para revisão. A instalação consulta as releases públicas sem credencial.

Releases completas incluem `release-inventory.json` com versão, SHA de origem, cinco alvos e hashes. O verificador exige Windows x64, Linux x64/ARM64 (AppImage, DEB, RPM e Arch) e macOS x64/ARM64 (ZIP e DMG), com os manifests de atualização. Os dois ZIPs macOS compartilham um manifest mesclado; Linux preserva os manifests por arquitetura. AppImage não exige um blockmap externo. Drafts antigos de Windows continuam compatíveis com o verificador.

macOS é compilado sem assinatura/notarização no fluxo atual; as notas públicas informam essa limitação e a ausência de validação de atualizações automáticas nesses builds.

O app é compilado no repositório privado. Este repositório recebe somente os instaladores, blockmaps, manifests de atualização e notas de versão.

1. Compile com a identidade de produção do Flatt e uma versão semântica. Para testes use `X.Y.Z-beta.N`.
2. No repositório do app, execute `pnpm release:desktop --dir <artefatos> --version <versão> --notes <arquivo>`. O comando valida os arquivos, cria um draft e verifica o upload baixando os arquivos novamente.
3. Abra **Actions → Verify and publish release**, informe a tag do draft (por exemplo `v0.0.1-beta.1`) e execute com `publish=false` para verificar.
4. Depois da validação dos instaladores, execute novamente com `publish=true`. O workflow recusa releases já publicadas e versões inconsistentes.

Releases beta ficam marcadas como prerelease e não substituem a versão estável em latest. Usuários habilitam atualizações de prévia no Flatt para recebê-las. O produto separado “flatt preview” não utiliza esse fluxo.

O verificador deste repositório usa sua credencial temporária do GitHub Actions. A publicação vinda do privado usa o secret restrito `FLATT_RELEASES_TOKEN`. O aplicativo instalado consulta as releases públicas sem login e sem token.

## Validação local

```sh
npm ci
npm test
node scripts/verify-release.mjs <diretório-de-artefatos> <versão>
```

## Estado inicial

Nenhum instalador de produção foi publicado. O primeiro alvo de validação é Windows x64. Uma atualização real exige dois instaladores: instalar a versão A, publicar a B e verificar download, reinício e preservação das configurações.

A compilação dos instaladores acontece separadamente. A assinatura de Windows e a assinatura/notarização de macOS precisam ser configuradas na máquina ou no runner de build.
