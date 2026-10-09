# Publicação e verificação do Flatt

Este documento descreve a manutenção do canal público de instaladores. Para conhecer o aplicativo e baixar uma versão, consulte o [README](../README.md).

## Fluxo de publicação

O workflow manual **Release desktop** em `LuminaSoft-br/flatt-app` compila os cinco alvos nativos, valida e reúne os arquivos, cria um draft, verifica os bytes enviados e publica quando `publish=true`. Ele requer o secret `FLATT_RELEASES_TOKEN` no privado, restrito a este repositório com Contents read/write. `publish=false` prepara um draft para revisão. A instalação consulta as releases públicas sem credencial.

Releases completas incluem `release-inventory.json` com versão, SHA de origem, cinco alvos e hashes. O verificador exige Windows x64, Linux x64/ARM64 (AppImage, DEB, RPM e Arch) e macOS x64/ARM64 (ZIP e DMG), com os manifests de atualização. Os dois ZIPs macOS compartilham um manifest mesclado; Linux preserva os manifests por arquitetura. AppImage não exige um blockmap externo. Drafts antigos de Windows continuam compatíveis com o verificador.

macOS é compilado sem assinatura/notarização no fluxo atual; as notas públicas informam essa limitação e a ausência de validação de atualizações automáticas nesses builds.

O app é compilado no repositório privado. Este repositório recebe somente os instaladores, blockmaps, manifests de atualização, notas de versão e materiais de apresentação do produto.

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

## Estado da distribuição

A versão [Flatt 0.0.1](https://github.com/LuminaSoft-br/flatt-releases/releases/tag/v0.0.1) foi publicada com os cinco alvos nativos. A consulta do feed e dos manifests públicos foi verificada para todos os alvos; instalação e atualização entre versões ainda precisam de validação em cada plataforma.

Uma atualização real exige dois instaladores: instalar a versão A, publicar a B com versão superior e verificar download, reinício e preservação das configurações. Recompilar a mesma versão não produz uma atualização de versão para quem já a instalou.

A compilação dos instaladores acontece separadamente. A assinatura de Windows e a assinatura/notarização de macOS precisam ser configuradas na máquina ou no runner de build.

## Materiais do README

`assets/flatt-icon.png` é o ícone do produto. `assets/flatt-workspace.png` apresenta a interface real com um projeto de demonstração e perfil separado, sem contas, chaves de API ou arquivos pessoais. A captura usa a interface compartilhada do aplicativo servida localmente, com um texto de exemplo no campo de mensagem; nenhuma execução de IA foi simulada. Ao renovar a imagem, preserve esse cuidado e mostre somente recursos disponíveis no aplicativo.
