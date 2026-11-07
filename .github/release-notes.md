<!-- GitHub turns every line break in release notes into a hard break, so keep each paragraph on one line. -->
## Download

| System | File |
|---|---|
| Windows 10 / 11 (64-bit) | `ViewEditor-Setup-<version>.exe` |
| macOS, Apple silicon (M1 and later) | `ViewEditor-<version>-arm64.dmg` |
| macOS, Intel | `ViewEditor-<version>-x64.dmg` |

Once it's installed, ViewEditor looks for new versions itself, downloads them, and installs them when you restart it. The `.zip`, `.yml` and `.blockmap` files below are what it updates from.

**On a Mac with ViewEditor 0.2.0 or earlier,** install this version by hand once: open the disk image and drag ViewEditor into Applications, replacing the old copy. Those versions can only tell you a new one is out. From this one on, ViewEditor updates itself. macOS asks again for permission to use the camera, the microphone and screen recording the first time you record.

### Opening it the first time

- **Windows:** the installer isn't signed with a publisher certificate yet, so Windows warns you once. When SmartScreen says "Windows protected your PC", click **More info** → **Run anyway**.
- **macOS:** open the disk image, drag ViewEditor into Applications, and open it from there. It can only update itself in Applications.

### FFmpeg

ViewEditor includes FFmpeg, licensed under the GPL version 3. Source code for the included builds: [Windows](https://github.com/FFmpeg/FFmpeg/tree/4571c80b40) (made with [FFmpeg-Builds](https://github.com/BtbN/FFmpeg-Builds)) and [macOS](https://github.com/jellyfin/jellyfin-ffmpeg/tree/v8.1.3-2).
