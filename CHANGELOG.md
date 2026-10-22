# Changelog

## 1.1.0

### Added

- Tmux panel beside an SSH terminal: see the host's sessions, attach or switch the terminal to one, jump to a window and start a new session

## 1.0.4

### Fixed

- Mouse mode and the history limit are applied when Termix attaches to a tmux session, so clicking windows and panes in tmux works again

## 1.0.3

### Changed

- Attach opens the session in a new Termix tab, and on the web you can pick a new browser tab instead. Needs SSH Terminal 1.0.3
- The plugin name and description show in your language

## 1.0.2

### Fixed

- Windows hosts running psmux showed "tmux is not installed". Hosts without /bin/sh now run tmux straight from cmd.exe or PowerShell

## 1.0.1

### Changed

- Translated into every supported language

## 1.0.0

### Added

- First release
- Every host's tmux sessions in one place, with live pane previews
- Resource use for each session
- Search across every pane
- Create, rename, split and kill sessions, windows and panes
- Attach a terminal in one click
