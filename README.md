<div align="center">
  <img src="logo.png" alt="NodePDF" height="40" />
</div>

<br />

<p align="center">
  A lightweight, fast desktop PDF viewer built with Electron and React.
  <br />
  Tabs, virtualized rendering, stamps, encrypted PDFs, full-text search, and more.
</p>

<p align="center">
  <a href="https://github.com/remdph/node-pdf/releases"><img alt="Version" src="https://img.shields.io/badge/version-0.1.0-cbd5e1?style=flat-square" /></a>
  <img alt="License" src="https://img.shields.io/badge/license-MIT-cbd5e1?style=flat-square" />
  <img alt="Platform" src="https://img.shields.io/badge/platform-Linux%20%7C%20Windows%20%7C%20macOS-cbd5e1?style=flat-square" />
</p>

---

## Screenshots

<table>
  <tr>
    <td width="50%" valign="top">
      <img src="screenshots/ss1.png" alt="Home view with recents carousel" />
      <p align="center"><sub>Home — open placeholder + recents carousel</sub></p>
    </td>
    <td width="50%" valign="top">
      <img src="screenshots/ss2.png" alt="PDF viewer with thumbnails sidebar" />
      <p align="center"><sub>Viewer — thumbnails, paginator, zoom, status bar</sub></p>
    </td>
  </tr>
  <tr>
    <td width="50%" valign="top">
      <img src="screenshots/ss3.png" alt="Stamps menu" />
      <p align="center"><sub>Stamps menu — pick, drag, resize, embed</sub></p>
    </td>
    <td width="50%" valign="top">
      <img src="screenshots/ss4.png" alt="Password protection dialog with outline panel" />
      <p align="center"><sub>Protect / unlock with outline panel open</sub></p>
    </td>
  </tr>
</table>

---

## Features

### Reading
- **Tabbed viewer** — open many PDFs side by side. Each tab keeps its scroll position, zoom and search across switches.
- **Overflow tab menu** — when tabs no longer fit the titlebar, the rest fold into a dropdown (active tab stays visible).
- **Outline panel** — opens automatically for documents that have a table of contents; click any entry to jump.
- **Thumbnails sidebar** — virtualized previews with active-page tracking.
- **Internal link navigation** — clickable cross-references and TOC links scroll to their target page.
- **Recents** — visual carousel of recently opened files with cached thumbnails and right-click context menu.

### Navigation
- **Paginator** in the toolbar: prev/next buttons, type-and-Enter page input, current/total indicator.
- **Zoom controls**: in / out / reset / fit-width, plus `Ctrl + wheel` over the document.
- **Status bar** at the bottom shows current page, total pages, zoom level and file size on disk.

### Search
- **Find-in-document** with multi-page text search (Enter to search, Enter again to advance, Shift+Enter to go back, Esc to close).
- **In-page highlighting** via the modern CSS Custom Highlight API — current match in orange, all matches in yellow, no DOM mutation, no interference with text selection.
- **Smart scrolling** — when the next match is on the same page and already visible, no extra scroll; otherwise the match is gently brought into view.

### Editing
- **Stamps** — add image stamps (PNG with transparency or JPEG), drag and resize on the page, then embed into the PDF.
- **Password protection** — set, change, or remove a password. Configurable permissions (print / copy / modify / annotate).
- **Open encrypted PDFs** — password prompt with retry-on-wrong-password and "cancel and retry later" state.
- **Copy selected text** — right-click any selection → Copy.

### Printing
- **Print dialog** with first-page preview and printer selection.

### Performance
- **Page virtualization** via `react-virtuoso` — large documents stay smooth.
- **Stale-while-revalidate snapshot cache** — pages keep their last rendered bitmap so zoom and scroll don't flash white.
- **Alive tabs** — inactive tabs are kept mounted but hidden, so switching is instant and never re-parses the PDF.

### UI
- **Frameless custom titlebar** with logo, home button, tabs, about (?), minimize / maximize / close.
- **Dark theme** by default with soft contrast accents — designed to feel like a native viewer surface.
- **Vector icons** and rem-based sizing — looks crisp on Hi-DPI displays.

---

## Install

Grab the right artifact for your OS from the [latest release](https://github.com/remdph/node-pdf/releases/latest):

| OS | Package |
| --- | --- |
| Windows | `NodePDF-*.Setup.exe` |
| macOS (Apple Silicon) | `NodePDF-*.dmg` |
| Debian / Ubuntu / Mint | `node-pdf_*_amd64.deb` |
| Fedora / openSUSE | `node-pdf-*.x86_64.rpm` |
| **Arch Linux** | `yay -S nodepdf-bin` (from the AUR) |
| Any Linux | `NodePDF-*-x86_64.AppImage` (chmod +x and run) |

## Quick start (development)

NodePDF requires **Node 22** (a `mise.toml` is included for [mise](https://mise.jdx.dev/) / asdf users) and **pnpm**.

```bash
pnpm install
pnpm dev
```

That launches the app in development mode (Vite + Electron with DevTools).

## Build & package

```bash
pnpm package    # build the app bundle (no installer)
pnpm make       # build platform-specific installers (deb/rpm/zip/squirrel/dmg)
```

## Tech stack

| Layer              | Library                                          |
| ------------------ | ------------------------------------------------ |
| Shell              | Electron 33 (frameless `BrowserWindow`)          |
| UI                 | React 18 + TypeScript (strict)                   |
| Bundling           | Vite + Electron Forge                            |
| PDF rendering      | `pdfjs-dist` 5.4 + `react-pdf` 10.4              |
| PDF writing        | `@cantoo/pdf-lib` (stamps, encryption, permissions) |
| Virtualization     | `react-virtuoso`                                 |
| Stamp drag/resize  | `react-rnd`                                      |
| State              | `zustand` with localStorage persistence          |

## Project layout

```
src/
  main/        Electron main process (windows, IPC handlers, app lifecycle)
  preload/     Context-isolated bridge that exposes a typed API to the renderer
  renderer/    React UI
    components/   PdfView, TitleBar, dialogs, stamps menu, recents…
    stores/       Zustand stores (tabs, stamps)
    styles/       global.css
  shared/      Types and IPC channel constants shared between main and renderer
```

## Roadmap (post-0.1.0)

- Annotation editing (highlights, comments) via pdfjs's `AnnotationEditorLayer`
- Form field filling
- Bookmarks
- Optional light theme

## License

MIT © Rafael Maldonado

## Support the project

If NodePDF saves you time, consider [buying me a coffee](https://www.buymeacoffee.com/remdph) — it helps keep development active.
