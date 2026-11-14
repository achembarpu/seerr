<p align="center">
<img src="./public/logo_full.svg" alt="Seerr" style="margin: 20px 0;">
</p>
<p align="center">
<img src="https://github.com/seerr-team/seerr/actions/workflows/release.yml/badge.svg" alt="Seerr Release" />
<img src="https://github.com/seerr-team/seerr/actions/workflows/ci.yml/badge.svg" alt="Seerr CI">
<a href="https://scorecard.dev/viewer/?uri=github.com/seerr-team/seerr"><img src="https://img.shields.io/ossf-scorecard/github.com/seerr-team/seerr?label=openssf" alt="OpenSSF Scorecard"></a>
</p>
<p align="center">
<a href="https://discord.gg/seerr"><img src="https://img.shields.io/discord/783137440809746482" alt="Discord"></a>
<a href="https://hub.docker.com/r/seerr/seerr"><img src="https://img.shields.io/docker/pulls/seerr/seerr" alt="Docker pulls"></a>
<a href="https://translate.seerr.dev/engage/seerr/"><img src="https://translate.seerr.dev/widget/seerr/svg-badge.svg" alt="Translation status" /></a>
<a href="https://github.com/seerr-team/seerr/blob/develop/LICENSE"><img src="https://img.shields.io/github/license/seerr-team/seerr" alt="GitHub"></a>

**Seerr** is a free and open source software application for managing requests for your media library. It integrates with the media server of your choice: [Jellyfin](https://jellyfin.org), [Plex](https://plex.tv), and [Emby](https://emby.media/). In addition, it integrates with your existing services, such as **[Sonarr](https://sonarr.tv/)**, **[Radarr](https://radarr.video/)**.

## Current Features

- Full Jellyfin/Emby/Plex integration including authentication with user import & management.
- Support for **PostgreSQL** and **SQLite** databases.
- Supports Movies, Shows and Mixed Libraries.
- Ability to change email addresses for SMTP purposes.
- Easy integration with your existing services. Currently, Seerr supports Sonarr and Radarr. More to come!
- Jellyfin/Emby/Plex library scan, to keep track of the titles which are already available.
- Customizable request system, which allows users to request individual seasons or movies in a friendly, easy-to-use interface.
- Incredibly simple request management UI. Don't dig through the app to simply approve recent requests!
- Granular permission system.
- Support for various notification agents.
- Mobile-friendly design, for when you need to approve requests on the go!
- Support for watchlisting & blocklisting media.

With more features on the way! Check out our [issue tracker](/../../issues) to see the features which have already been requested.

## Getting Started

Check out our documentation for instructions on how to install and run Seerr:

https://docs.seerr.dev/getting-started/

## Local title search

Administrators can enable local typo-tolerant title search in General Settings. Seerr downloads IMDb title and vote datasets and TMDB title exports, builds a local index in the configuration directory, and refreshes it daily. Allow hundreds of megabytes for the index plus temporary space during imports. General Settings shows each source’s status, lets you refresh manually, and schedules a retry after one hour if an update fails. Normal TMDB search remains available while the index builds or if a refresh fails. Once an index has been built, its previous contents remain searchable while an update is published. Two-character searches are supported for short titles in non-Latin scripts; most other local title searches need at least three characters. The index uses IMDb primary and original titles and TMDB original titles, so an alternative title that occurs only in another alias or translation may still be missed. Each refresh checks IMDb using its ETag, but a changed daily dataset must be downloaded again; TMDB publishes a new ID export each day. Matching titles appear in the same results grid as regular search results, including people. A magnifying-glass icon marks a local title match.

IMDb permits a personal movie database for individual personal, non-commercial use, subject to [IMDb's terms](https://help.imdb.com/article/imdb/general-information/can-i-use-imdb-data-in-my-software/G5JTRESSHJBBHTGX). Enable this feature only if your use complies. Information courtesy of IMDb (https://www.imdb.com). Used with permission. Disabling it cancels active downloads and hides suggestions but retains the rebuildable index on disk. A database publication already in progress may finish.

## Preview

<img src="./public/preview.jpg" alt="Seerr application preview" />

## Migrating from Overseerr/Jellyseerr to Seerr

Read our [release announcement](https://docs.seerr.dev/blog/seerr-release) to learn what Seerr means for Jellyseerr and Overseerr users.

Please follow our [migration guide](https://docs.seerr.dev/migration-guide) for detailed instructions on migrating from Overseerr or Jellyseerr.

## Support

- Check out the [Seerr Documentation](https://docs.seerr.dev) before asking for help. Your question might already be in the docs!
- You can get support on [Discord](https://discord.gg/seerr).
- You can ask questions in the Help category of our [GitHub Discussions](/../../discussions).
- Bug reports and feature requests can be submitted via [GitHub Issues](/../../issues).

## API Documentation

You can access the API documentation from your local Seerr install at http://localhost:5055/api-docs

## Community

You can ask questions, share ideas, and more in [GitHub Discussions](/../../discussions).

If you would like to chat with other members of our growing community, [join the Seerr Discord server](https://discord.gg/seerr)!

Our [Code of Conduct](./CODE_OF_CONDUCT.md) applies to all Seerr community channels.

## Contributing

You can help improve Seerr too! Check out our [Contribution Guide](./CONTRIBUTING.md) to get started.

## Contributors ✨

[![Contributors](https://opencollective.com/seerr/contributors.svg?width=890)](https://opencollective.com/seerr/#backers)

[![Become a Backer](https://opencollective.com/seerr/backers.svg)](https://opencollective.com/seerr/#backers)
[![Become a Sponsor](https://opencollective.com/seerr/sponsors.svg)](https://opencollective.com/seerr/#sponsors)

## Local smart search

Administrators can enable Local smart search in General Settings. Seerr downloads a pinned 119 MB multilingual embedding model, verifies its SHA-256 hash, then builds a separate local index of TMDB movie and series descriptions. The initial scan works from recent years backwards and can take a long time, use substantial CPU and network traffic, and require significant disk space. Search becomes available as titles are indexed. Titles without a release/first-air date or usable description are not included. English descriptions are preferred, with original-language descriptions used when English is unavailable.

When enabled, description matches appear alongside title and people matches in the search results; a sparkle icon marks description matches. Filters apply to the combined results by type, genre, original language, year, TMDB rating, and vote count. When a title is a close match, only a few additional description-only results are shown. Discover recommendations use only the signed-in user's recent requests. Movie and series pages also show matches similar by description. A small, capped vote-count bonus breaks close similarity ties without removing lesser-known titles; ratings remain an explicit filter. These suggestions are based on indexed metadata, so coverage and relevance vary; normal search remains available.

After the initial scan, the index checks TMDB change lists daily and only re-embeds changed descriptions. If a refresh is interrupted, Seerr resumes from its checkpoint. Change-list requests cover one day at a time, so refresh can resume after interruptions without requesting an oversized date range. Settings show progress and errors and provide a manual refresh. Disabling the feature stops indexing and the model process but retains the model and rebuildable index. The model process unloads after 15 minutes of inactivity.

The device selector in General Settings chooses automatic, CPU, or a detected GPU. Automatic tries the first detected GPU and falls back to CPU if startup or a test embedding fails. A specifically selected device reports an error if unavailable. The status shows the active device and any fallback. Changing the selection restarts indexing from its checkpoint. The Docker runtime includes Vulkan support for GPUs accessible to the Linux container. On Linux, expose a compatible render device (for example `--device /dev/dri`) and grant the `node` user access to its render group. NVIDIA also requires its container toolkit, Vulkan driver and graphics capability. GPU models, drivers, container permissions and host VM support vary; CPU fallback remains available. The Vulkan container has not been validated on every GPU or driver.

### macOS app

The private Apple Silicon build is a self-contained macOS app for macOS 13.5 or later. Unzip `Seerr-macOS-arm64.zip`, drag `Seerr.app` to Applications, and open it. The Seerr menu-bar item shows whether the server is running and provides **Open Seerr**, **Show Data Folder**, and **Quit Seerr**. The app opens Seerr in your browser; it is a local server rather than a separate browser shell. It includes Node and the Metal inference runtime, but downloads the embedding model only after smart search is enabled. Metal is selected automatically when available. Replacing the app preserves the configuration, indexes, and downloaded model in `~/Library/Application Support/Seerr`; background refreshes can continue after an upgrade.

The app listens on `127.0.0.1:5055` by default. To allow access from other devices, choose **Allow Network Access** in its menu and then quit and reopen it; Seerr will listen on all interfaces and clients must sign in. Configuration, the database, cache and models are kept in `~/Library/Application Support/Seerr`, separate from the app, so replacing the app preserves your data. Quit the app before replacing it. If port 5055 is occupied, stop the other service first.

The private archive is ad-hoc signed, not Developer ID signed or notarized. macOS Gatekeeper may require opening it once via System Settings → Privacy & Security. This build does not install a login item or start automatically after a reboot. To build it from this checkout on an Apple Silicon Mac with Node, pnpm, Git, CMake and Xcode command-line tools, run `scripts/build-macos-app.sh`; the app and ZIP are placed in `build/macos`. The model and TMDB/IMDb data are never embedded in the app.

### macOS from source or Docker Desktop with Metal

Seerr can run directly as a macOS Node application; it is still accessed in a browser. To compile the pinned Metal runtime, install Git, CMake and Xcode command-line tools, then run:

```sh
./scripts/smart-search-metal.sh --install
pnpm install
pnpm build
SEERR_LLAMA_SERVER="$HOME/Library/Caches/Seerr/smart-search/llama-32bdc3a89e6528d3e419024c833c5dabf32c7541/bin/llama-server" pnpm start
```

Enable smart search and leave the device on Automatic or select the detected Metal GPU. The runtime is built for the host; the model is downloaded separately when the feature is enabled. See [development setup](CONTRIBUTING.md#development) for Node and pnpm requirements. This runs the native server directly from the source checkout. It uses Metal GPU inference; Apple Neural Engine inference is not supported.

Docker Desktop runs Linux containers and does not provide the macOS Metal API to the packaged Linux runtime. To use the Mac GPU while keeping Seerr in Docker, first build the runtime and run the optional host helper in a terminal:

```sh
export SEERR_EMBEDDING_API_KEY="$(openssl rand -hex 32)"
./scripts/smart-search-metal.sh
```

The helper downloads and verifies the same pinned model and listens on host loopback at port 38767; keep it running. Pass `SEERR_EMBEDDING_URL=http://host.docker.internal:38767` and the **same** `SEERR_EMBEDDING_API_KEY` into the Seerr container, restart the container, then select **Host inference service** in General Settings. Keep the generated key private and persist it securely if the services restart separately. Seerr verifies the expected model alias and performs a test embedding before use. The helper and container have separate process lifecycles: stopping Seerr does not stop the host helper or unload its model. The helper uses HTTP over Docker Desktop's local host connection; do not expose the port or key to untrusted networks. `SEERR_METAL_RUNTIME_DIR`, `SEERR_METAL_PORT`, and `SEERR_METAL_BIND` override the helper's defaults if needed.

Model weights and movie metadata are downloaded only after the feature or host helper is enabled. TMDB's applicable terms and access permissions remain the user's responsibility.
