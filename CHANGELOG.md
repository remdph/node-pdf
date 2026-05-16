# Changelog

All notable changes to NodePDF will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.1] — 2026-05-15

### Fixed
- macOS: ad-hoc sign the .app bundle so Apple Silicon stops flagging
  downloaded copies as "damaged and can't be opened". Users who already
  installed 0.1.0 can also fix it manually with
  `xattr -dr com.apple.quarantine /Applications/NodePDF.app`.

## [0.1.0] — 2026-05-15

Initial public release.

### Reading
- Tabbed viewer with state preservation across tab switches.
- Overflow menu when tabs no longer fit the titlebar; active tab is pinned visible.
- Outline panel that auto-opens for documents with a table of contents.
- Thumbnails sidebar with virtualized rendering and active-page tracking.
- Internal link navigation (cross-references and TOC links).
- Recents carousel on the home screen with cached thumbnails and a right-click context menu.

### Navigation
- Page paginator in the toolbar: prev/next buttons + type-and-Enter page input + current/total indicator.
- Zoom in / out / reset / fit-width controls and `Ctrl + wheel` zoom.
- Status bar showing current page, total pages, zoom level, and file size on disk.

### Search
- Find-in-document with multi-page text search (Enter / Shift+Enter / Esc).
- In-page highlighting via the CSS Custom Highlight Registry (no DOM mutation).
- Smart scroll-into-view: same-page matches don't reset scroll if already visible.

### Editing
- Image stamps (PNG/JPEG) with drag-to-place and resize, then embedded into the PDF.
- Password protection — set, change, or remove a password with configurable permission flags.
- Open encrypted PDFs with retry-on-wrong-password and "cancel and retry later" state.
- Right-click context menu on selected text with Copy action.

### Printing
- Print dialog with first-page preview and printer selection.

### Performance
- Page virtualization via `react-virtuoso`.
- Stale-while-revalidate snapshot cache so pages keep their last bitmap during zoom/scroll.
- Inactive tabs stay mounted (`display: none`) — no re-parse on activation.

### UI
- Frameless custom titlebar with logo, home button, tabs, about dialog, and window controls.
- Dark theme with soft contrast accents.
- Vector icons and rem-based sizing for crisp Hi-DPI rendering.

### Distribution
- Linux: `.deb`, `.rpm` packages.
- Windows: Squirrel `.exe` installer.
- macOS: `.dmg` disk image and `.zip` portable bundle.

[0.1.1]: https://github.com/remdph/node-pdf/releases/tag/v0.1.1
[0.1.0]: https://github.com/remdph/node-pdf/releases/tag/v0.1.0
