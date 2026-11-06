# ViewEditor

A desktop video editor for Windows and macOS, built from the feature set described in the
[Getting Started with VEED](https://support.veed.io/en/collections/3812805-getting-started-with-veed)
documentation. It is an independent app, with no connection to VEED.

Editing and rendering run on your computer, with no account, plan or credit system. AI video generation
is optional and connects to the service of your choice with your own key.

## Download

Installers for Windows and macOS are on the
[Releases](https://github.com/SteveDeveloperConcepts/ViewEditor/releases) page. Once installed, ViewEditor
looks for new versions itself.

## Running it

Needs [Node.js](https://nodejs.org) 22 or newer.

```bash
npm install
npm run dev
```

## Building installers

```bash
npm run dist:win
```

```bash
npm run dist:mac
```

Installers land in `release/`. Each platform has to be built on that platform, because FFmpeg is
downloaded per system when you run `npm install`.

Every push to `main` runs [.github/workflows/build.yml](.github/workflows/build.yml) on GitHub, which runs
the tests on Windows and on a real Mac, then builds the Windows, Apple silicon and Intel Mac installers.
Download them from the run's Artifacts. To publish them, see [docs/RELEASING.md](docs/RELEASING.md).

## Testing

```bash
npm run fixtures
```

```bash
npm test
```

```bash
npm run test:e2e
```

`npm run fixtures` generates sample media (once). `npm test` runs the unit tests and integration tests
against the real FFmpeg, checking actual pixels and audio levels in exported files. `npm run test:e2e`
drives the built app with real clicks and drags. Set `VIEWEDITOR_E2E_EXE` to run it against a packaged
build. Screenshots are saved in `tests/e2e/.artifacts`.

AI tests run against `tests/support/fakeProviders.mts`, a local stand-in that speaks each service's protocol
and serves their real published schemas, so they cost nothing and need no keys.

## What the documentation covers, and where it is here

| Documentation | In ViewEditor |
| --- | --- |
| **Dashboard:** home page, left navigation, Recents, Assets, Brand, Templates, More apps | All there, regrouped. The left menu has Create (Edit my footage, Generate with AI, Video from a script, Record) and Library (Projects, Media, Templates, Brand). |
| **AI Studio and AI Playground:** talking videos, AI images and video, from a prompt or a script | Through the AI services you connect. See [AI video](#ai-video). |
| **Project Library:** cards, ••• menu (edit, rename, duplicate, move, save as template, resize for social, download, trash), multi-select | All there, under Projects. Resize for social is Copy in a new shape, and download is Save video. "Share" is replaced by Show in folder, since nothing is hosted. |
| **Spaces and folders** | Create, rename, delete, nest. Deleting one never deletes projects. Spaces stay out of sight until you make a second one, from the ••• menu on Projects. |
| **Trash:** 30 days, restore, delete permanently | All there. |
| **Timeline:** play, frame skip, playhead, resize, zoom, select, right-click menu, trim, split, download section, group, close gaps, reorder with snapping, layers | All there. Rows have names, with controls to hide their picture or mute their sound. |
| **New projects:** from a prompt, a script, a template, a blank project, or a recording | All there, with the differences below. A project is only created once there is something to put in it. |
| **Upload:** to the workspace, to a project, drag and drop, several at once, from a phone | All there. Everything you add, record or generate is kept in one Media library. Phone upload works over your Wi-Fi with a QR code. |
| **Formats:** MP4, M4V, MOV, MKV, WEBM, AVI, OGV, FLV, TS, GIF · MP3, M4A, OGG, OGA, WAV, AAC, FLAC · JPG, PNG, WEBP, AVIF | All import. Formats the editor cannot play get a preview proxy; export always reads the original. |
| **Export:** quality presets, Advanced, H.264 + AAC in MP4, bt709, variable bitrate by default, constant-bitrate YouTube presets, HDR to SDR | All there, in the Export dialog, with the size of your footage as the default. No resolution is locked behind a plan. |
| **Download:** MP4, MP3, GIF from the video page | All there. The Export dialog can also make any of the three directly, for the whole project, the selected clips or a stretch of time. |
| **Recorder:** screen, camera or both | All there, plus audio only. System audio can be recorded on Windows. |
| **Brand Kits:** logos, colours, fonts | All there. |

## AI video

Connect a service under **AI connections** (in the left menu, or the AI tools panel in the editor) with your own
API key. Keys are encrypted by your operating system and stay out of the interface.

| Service | Reaches | Get a key |
| --- | --- | --- |
| [fal.ai](https://fal.ai) | Kling, Seedance, Veo, Gemini Omni, MiniMax, WAN, Grok, Flux, and VEED's own Fabric talking-video model | [fal.ai/dashboard/keys](https://fal.ai/dashboard/keys) |
| [Runway](https://dev.runway.com) | Gen-4.5, Aleph video editing, and models from other labs on Runway credits | [dev.runway.com](https://dev.runway.com) |
| [Replicate](https://replicate.com) | A large catalogue of official and community models | [replicate.com/account/api-tokens](https://replicate.com/account/api-tokens) |

What you can do once connected:

| Where | What |
| --- | --- |
| **Generate with AI** (left menu) | Opens the editor on the AI tools panel, with nothing to set up first. |
| **AI tools panel** (editor) | Every AI tool in one place: video from text or an image, pictures, talking photos, editing a video and lip-sync. A new clip can take its sound from a stretch of anything in Media, and lands lined up with it. |
| **Select a clip** (editor) | **Edit with AI** (describe a change), **Extend with AI**, **Lip-sync with AI**. On an image: **Animate with AI**, **Make it talk**. These open the AI tools panel with the clip filled in, and **Restore original** brings back what was replaced. |
| **Video from a script** | Turn a script into **AI scenes** (a generated clip per moment of narration) or a **talking character** (a photo, lip-synced to the voice-over). The project opens in the editor and clips land as they finish. |
| **Subtitles panel** (editor) | **Make subtitles automatically** from the speech in the project. This uses fal.ai. |

Generated clips are ordinary clips: trim, split, layer, subtitle and export them like anything else. They are
kept in Media too, for use in any project.

- **Models are not hard-coded.** The app reads each service's published model schemas, so new models appear
  by themselves and it can only send settings the chosen model accepts. Lists are cached for a day, with a
  copy shipped in the app (`npm run ai:catalog` refreshes that copy).
- **Costs.** Generating is billed to your account with that service. The price is shown where the service
  publishes one, with what the clip comes to, and multi-clip work is confirmed first.
- **Lengths.** A model that cannot make the length you ask for makes the next one up, and the clip is trimmed
  when it lands. The form says when this happens.
- **Privacy.** Nothing is sent until you press Generate. Only what is needed goes: the used part of a clip,
  not the whole file.
- **Reliability.** A job is saved the moment the service accepts it, so closing the app does not lose a
  generation you have paid for. It is collected the next time the app opens.

To add a service, implement the small `AiProvider` interface in `src/main/ai/provider.ts`.

### Different by design

- **Voices come from your operating system.** Script videos are narrated on your computer, with subtitles
  timed to the voice.
- **Drafting a script from a topic uses the Claude API** with your own key, added under AI connections and
  encrypted by your operating system. Pasting your own script needs no key.

### Left out

- AI dubbing, AI clips and voice cloning.
- Stock video, music and images, which need a licensed library.
- Accounts, teams, collaborators, comments, credits and billing, which only make sense for a hosted service.
- Interface languages other than English.

## How it is put together

| Folder | Contents |
| --- | --- |
| `src/shared` | Pure logic used everywhere: the data model, timeline operations, and the plan that turns a project into FFmpeg commands. |
| `src/main` | Electron main process: library storage, media import, render jobs, recorder, voices, phone upload. |
| `src/main/ai` | AI service connections, the model catalogue, and generation jobs. |
| `src/preload` | The only bridge between the page and the system, limited to the calls in `src/shared/api.ts`. |
| `src/renderer` | The React interface. |

Text is drawn by one piece of canvas code for both the preview and the export, so what you see is what
you get. Exports are rendered in chunks that are joined without re-encoding, so a project with hundreds
of cuts never opens hundreds of files at once.

Your library lives in the app data folder (`%APPDATA%\ViewEditor\library` on Windows,
`~/Library/Application Support/ViewEditor/library` on macOS). Settings › Library opens it.

## Before you distribute it

- **FFmpeg licence.** ViewEditor's code is MIT, and the FFmpeg programs in the installers are GPLv3, so their
  source has to stay available. [licenses/FFMPEG.md](licenses/FFMPEG.md) links to it. The Mac binaries that
  npm installs are not redistributable, so Mac builds swap in another build:
  [docs/RELEASING.md](docs/RELEASING.md#ffmpeg) has the details.
- **Patents.** H.264 and AAC are covered by patent pools, which can matter for commercial distribution.
- **Signing.** Builds are unsigned, so Windows SmartScreen and macOS Gatekeeper will warn. Removing the
  warnings needs a code signing certificate and an Apple Developer account.
- **Naming.** Do not use VEED's name or logo for this app.

## Licence

[MIT](LICENSE). FFmpeg, included in the installers, is under the
[GPL version 3](licenses/FFMPEG.md).
