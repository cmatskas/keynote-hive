---
inclusion: always
---
# Transcribely Project Conventions

1. **Release notes** — All changelog entries go in `RELEASE_NOTES.md`, never in `README.md`.
2. **README updates** — Update `README.md` (features list, version references) when making a significant commit with meaningful changes.
3. **Version bump** — Always bump the version (`npm version patch/minor/major --no-git-tag-version`) before committing and pushing. Bug fixes = patch, new features = minor, breaking changes = major.
4. **Distributables** — Built by CI, never locally. Pushing a `v*` tag triggers `.github/workflows/release.yml`, which gates on the `test` job (unit tests + the live Mantle check, requires the `MANTLE_API_KEY` secret) and then builds and publishes all three targets: macOS Universal DMG (`--mac --universal`), Windows x64 (`--win --x64`), and Windows ARM64 (`--win --arm64`). Don't run local builds and don't offer to — just confirm the tag was pushed and point at the Actions tab.
