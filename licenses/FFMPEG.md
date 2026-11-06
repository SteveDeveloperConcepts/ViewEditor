# FFmpeg in ViewEditor

ViewEditor runs FFmpeg as a separate program to read media and export video. ViewEditor's own code is under
the MIT licence. The FFmpeg programs in its installers are under the GNU General Public License, version 3,
which is in `GPL-3.0.txt` next to this file.

| Installer | FFmpeg build | Source code | How it was built |
| --- | --- | --- | --- |
| Windows | n6.1.2-9-g4571c80b40-20241023 | [FFmpeg at 4571c80b40](https://github.com/FFmpeg/FFmpeg/tree/4571c80b40) | [FFmpeg-Builds](https://github.com/BtbN/FFmpeg-Builds) |
| macOS | Jellyfin FFmpeg 8.1.3-2 | [jellyfin-ffmpeg at v8.1.3-2](https://github.com/jellyfin/jellyfin-ffmpeg/tree/v8.1.3-2) | The `builder` folder of the same repository |

The build recipes list the exact library versions compiled in. Neither build uses `--enable-nonfree`.
