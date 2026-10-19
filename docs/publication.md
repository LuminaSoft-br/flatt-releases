# Publicação e verificação do Flatt

Este documento descreve a manutenção do canal público de instaladores. Para conhecer o aplicativo e baixar uma versão, consulte o [README](../README.md).

## Fluxo de publicação

O workflow manual **Build desktop release** neste repositório público compila os cinco alvos em runners padrão do GitHub. O código permanece no repositório privado `LuminaSoft-br/flatt-app`; o workflow recebe o SHA completo de um commit aprovado, lê sua versão e compila todos os destinos a partir desse mesmo commit. `publish=false` prepara um draft verificado para revisão. A instalação consulta as releases públicas sem credencial.

Configure o secret de repositório `FLATT_SOURCE_READ_TOKEN` em **Settings → Secrets and variables → Actions** deste repositório. Use um token fine-grained com expiração curta, restrito a `flatt-app` e permissão **Contents: Read-only**. Ele permite o checkout e o download do runtime Windows já fixado por hash. Não é necessário dar escrita no fonte; este pipeline não cria tags privadas.

Releases completas incluem `release-inventory.json` com versão, SHA de origem, cinco alvos e hashes. O verificador exige Windows x64, Linux x64/ARM64 (AppImage, DEB, RPM e Arch) e macOS x64/ARM64 (ZIP e DMG), com os manifests de atualização. Os dois ZIPs macOS compartilham um manifest mesclado; Linux preserva os manifests por arquitetura. AppImage não exige um blockmap externo. Drafts antigos de Windows continuam compatíveis com o verificador.

macOS é compilado sem assinatura/notarização no fluxo atual; as notas públicas informam essa limitação e a ausência de validação de atualizações automáticas nesses builds.

Os checkouts privados são temporários e não persistem a credencial. A saída dos comandos de instalação, preparação, compilação e empacotamento é descartada, inclusive quando falham: o log público mostra somente o estágio e seu resultado. Isso evita publicar trechos de fonte em erros de compilação. Não são enviados caches de dependências, checkouts, logs brutos ou arquivos de fonte. Somente uma pasta nova com o allowlist validado de instaladores, blockmaps, manifests e proveniência é enviada como artifact.

1. No fonte privado, prepare uma nova versão semântica no `package.json` raiz e suas notas explicitamente públicas em `docs/release-notes-<versão>.md`. Para testes use `X.Y.Z-beta.N`. Faça commit e push da revisão aprovada.
2. Neste repositório, abra **Actions → Build desktop release**, selecione `master`, informe o SHA completo do fonte e mantenha `publish=false`.
3. O workflow compila Windows x64, Linux x64/ARM64 e macOS Intel/ARM64, valida cada destino, reúne o inventário completo, cria um draft e verifica cada arquivo baixando-o novamente. Falha ou ausência de qualquer destino impede a publicação. Em falha, o nome do estágio no Actions identifica a operação a reproduzir privadamente; a saída privada não é recuperável pelo log público.
4. Depois de validar os instaladores, abra **Verify and publish release**, informe a tag do draft e execute com `publish=true`. Não é necessário recompilar para publicar. O workflow recusa releases já publicadas e versões inconsistentes. Para uma execução já autorizada a publicar diretamente, `Build desktop release` também aceita `publish=true`.

Releases beta ficam marcadas como prerelease e não substituem a versão estável em latest. Usuários habilitam atualizações de prévia no Flatt para recebê-las. O produto separado “flatt preview” não utiliza esse fluxo.

O verificador e a preparação/publicação neste repositório usam a credencial temporária do GitHub Actions, com escrita somente no job de publicação. O fluxo anterior no privado permanece disponível e requer `FLATT_RELEASES_TOKEN`, mas consome a cota de build daquele repositório. O aplicativo instalado consulta as releases públicas sem login e sem token. A política e os testes do novo fluxo estão em [Public native desktop builds](spec/public-native-builds.md).

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
