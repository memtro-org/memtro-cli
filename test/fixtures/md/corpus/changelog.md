# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

### Added
- `--json` output for `widget list` ([#212](https://github.com/acme/widget/pull/212)).
- Support for **Windows** paths.

### Fixed
- A crash when the config file was empty.
- ~~Slow startup~~ Startup is now 3× faster.

## [1.4.0] - 2026-10-02

### Changed
- Dropped Node 18. See the [upgrade guide][upgrade].
- Renamed `widget.make()` to `widget.create()`:

  ```diff
  - const w = widget.make();
  + const w = widget.create();
  ```

### Security
- Escape control characters in titles (CVE-2026-0001).

[Unreleased]: https://github.com/acme/widget/compare/v1.4.0...HEAD
[1.4.0]: https://github.com/acme/widget/releases/tag/v1.4.0
[upgrade]: https://acme.dev/upgrade
