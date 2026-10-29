<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="docs/header-dark.png">
    <img alt="Scratcher" src="docs/header-light.png" width="440">
  </picture>
</p>

A plain text pad that slides out in your browser's side panel, next to whatever page you're on. Made for [Dia](https://www.diabrowser.com), and works in Chrome and other Chromium browsers too.

![Scratcher demo](docs/scratcher-demo.gif)

[Watch the demo as MP4](docs/scratcher-demo.mp4)

## What it does

- **Opens beside the page.** Click the toolbar button, or press ⌥⇧D (Alt+Shift+D) to open and close it
- **Takes text from anywhere.** Type, paste, or drag text and text files in. Or select text on any page, right-click and choose Send to Scratcher
- **Cleans up pastes.** Removes stray spaces, invisible characters and extra blank lines. ⌘⇧V pastes exactly as copied
- **Counts as you go.** Words and characters, including what you've selected
- **Reads aloud.** Reads the selection, or everything if nothing is selected
- **Saves as you type.** Reopens right where you left off. Nothing leaves your computer

## Shortcuts

| Action | Mac | Windows / Linux |
|---|---|---|
| Open or close the panel | ⌥⇧D | Alt+Shift+D |
| Read aloud / stop | ⌘⇧L, Esc to stop | Ctrl+Shift+L |
| Copy all (or the selection) | ⌘⇧↩ | Ctrl+Shift+Enter |
| Clear (with Undo) | ⌘⇧⌫ | Ctrl+Shift+Backspace |
| Paste without cleanup | ⌘⇧V | Ctrl+Shift+V |

Change the open shortcut at `dia://extensions/shortcuts` (or `chrome://extensions/shortcuts`).

## Install

1. Download or clone this repo.
2. Open `dia://extensions` (or `chrome://extensions`) and turn on Developer mode.
3. Click Load unpacked and choose this folder.
4. Pin Scratcher to the toolbar.

To update, pull the latest and click the reload arrow on Scratcher's card.

## Privacy

Permissions are side panel, storage and the right-click menu. Scratcher can't read the pages you visit; it only gets text you send to it. Your text is stored locally in the browser and never synced or sent anywhere. Full [privacy policy](PRIVACY.md).

## Credit

Saving approach adapted from [NewTabPad](https://github.com/s-wool/NewTabPad) by Norikazu Kato. MIT licensed, see [LICENSE](LICENSE).
