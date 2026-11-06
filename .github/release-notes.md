<!-- GitHub turns every line break in release notes into a hard break, so keep each paragraph on one line. -->
## Download

| System | File |
|---|---|
| Windows 10 / 11 (64-bit) | `ViewEditor-Setup-<version>.exe` |
| macOS, Apple silicon (M1 and later) | `ViewEditor-<version>-arm64.dmg` |
| macOS, Intel | `ViewEditor-<version>-x64.dmg` |

Once it's installed, ViewEditor looks for new versions itself. On Windows it downloads them and installs them when you restart it. On a Mac it tells you when there's a new one to download.

### Opening it the first time

These builds aren't signed with a publisher certificate yet, so your system warns you once:

- **Windows:** when SmartScreen says "Windows protected your PC", click **More info** → **Run anyway**.
- **macOS:** drag ViewEditor into Applications and open it. When macOS says it can't verify the app, click **Done**. Then open **System Settings → Privacy & Security**, scroll down and click **Open Anyway**.

### FFmpeg

ViewEditor includes FFmpeg, licensed under the GPL version 3. Source code for the included builds: [Windows](https://github.com/FFmpeg/FFmpeg/tree/4571c80b40) (made with [FFmpeg-Builds](https://github.com/BtbN/FFmpeg-Builds)) and [macOS](https://github.com/jellyfin/jellyfin-ffmpeg/tree/v8.1.3-2).
