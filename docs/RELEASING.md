# Releasing ViewEditor

`npm run release` publishes a new version. It raises the version in `package.json`, commits it, tags the
commit with your release notes, and pushes the commit and tag together. The tag starts the **Release**
workflow, which tests the app and builds the Windows and macOS installers on GitHub's servers, signs and
notarises the Mac apps, then publishes them. After the one-time setup, you don't need a Mac to ship the
Mac version.

## One-time setup

Mac updates only install if the app is signed with a Developer ID and notarised by Apple, so the Release
workflow refuses to publish without these. A release that shipped unsigned could never update itself.

**1. Get the certificate.** On your Mac, in Xcode, go to **Settings > Accounts > Manage Certificates** and add
a **Developer ID Application** certificate, if you do not have one. Then open **Keychain Access**, find it
under **My Certificates**, right-click it, and choose **Export**. Save it as a `.p12` file with a password.

Turn the file into text and copy it:

```bash
base64 -i certificate.p12 | pbcopy
```

**2. Make an app-specific password.** At [account.apple.com](https://account.apple.com), open **Sign-In and
Security**, then **App-Specific Passwords**. Apple uses this to notarise builds.

**3. Add five repository secrets.** On GitHub, open this repository's **Settings > Secrets and variables >
Actions** and add:

| Secret | Value |
| --- | --- |
| `MAC_CERTIFICATE` | The text from step 1 |
| `MAC_CERTIFICATE_PASSWORD` | The `.p12` password |
| `APPLE_ID` | The email address of your Apple Developer account |
| `APPLE_APP_SPECIFIC_PASSWORD` | The password from step 2 |
| `APPLE_TEAM_ID` | Your Team ID, under Membership details on developer.apple.com |

Delete the `.p12` file afterwards.

## Publishing a release

1. Commit and push the work you're releasing, and check that the **Build** workflow passed on the
   repository's **Actions** tab. It's the same build the release uses.
2. Run `npm run release` with the new version, then one quoted line for each change. Each line appears under
   **What's new** on the release page:

   ```bash
   npm run release -- <new version> "<what changed>" "<what else changed>"
   ```

   Replace each `<…>`, angle brackets included, with your own text:
   - the version: three numbers, higher than the one in `package.json` (or the same, for the first release)
   - each change: one short sentence written for the people who use ViewEditor

   Add `--dry-run` to see the plan and the release notes without changing anything.

   Before it changes anything, it checks that:
   - the version isn't lower than the current one
   - you have no uncommitted changes
   - nobody has pushed to the branch since you last pulled
   - the tag doesn't exist yet

   If a check fails, it says what's wrong and changes nothing.

3. Follow the **Release** workflow on the **Actions** tab. `npm run release` prints the link. It builds:
   - `ViewEditor-Setup-<version>.exe` for Windows
   - `ViewEditor-<version>-arm64.dmg` and `ViewEditor-<version>-x64.dmg` for Apple silicon and Intel Macs,
     and a `.zip` of each Mac app, which installed copies update from

   It signs the Mac apps with your Developer ID and has Apple notarise them, which can take a while. Then it
   checks every Mac app, including the ones in the zips and disk images, and publishes the release. The
   release notes contain:
   - **What's new**, from your lines
   - the download notes from `.github/release-notes.md`
   - a link to every change since the last release

**If the build fails**, nothing is published. Delete the tag on GitHub and on your computer, replacing
`<version>` with the version you released:

```bash
git push origin :refs/tags/v<version>
```

```bash
git tag -d v<version>
```

Then fix the problem, commit and push the fix, and run `npm run release` again with the same version and
notes. `package.json` already has that version, so this time it only tags and pushes.

Once a release is published, it can't be replaced this way. To change its notes, open the release on
GitHub and click **Edit**.

## Signing

The Release workflow signs the Mac apps with your Developer ID and has Apple notarise them, so macOS opens
them without a warning and installs their updates. If a secret is missing, or an app isn't signed and
notarised, the workflow fails and publishes nothing.

Every other Mac build has an ad-hoc signature (`build/adhoc-mac.yml`): the ones `npm run dist:mac` makes,
and the ones the **Build** workflow makes on every push. They run, but can't install updates. macOS warns
you the first time you open one downloaded from a **Build** run: click **Done**, then open **System
Settings → Privacy & Security**, scroll down and click **Open Anyway**.

The Windows installer has no publisher certificate, so SmartScreen warns people the first time they run it,
and the release notes explain how to get past it. Updates install without that warning. A Windows
code-signing certificate would remove it.

## How installed copies update

ViewEditor checks the latest GitHub release 10 seconds after it starts, then every 4 hours
(`src/main/updater.ts`). It downloads a newer version in the background and shows **Restart now**. If the
user doesn't restart, the new version installs the next time they quit ViewEditor. `npm run dev` never
checks.

- **Windows:** the installer installs it.
- **macOS:** Squirrel.Mac installs it from the release's zip, but only over a copy in Applications, and only
  if it's signed with the same Developer ID as that copy. A copy anywhere else, such as one opened from the
  disk image, says when a new version is out, and offers **Move to Applications**. If Squirrel.Mac refuses
  an update, ViewEditor offers its release page instead.

The checks read files that electron-builder writes next to the installers, and the workflow attaches them
to the release: `latest.yml` (Windows), `latest-mac.yml`, the Mac `.zip` files, and the `.blockmap` files,
which let a copy download only what changed. Don't delete them from a release.

**Macs on 0.2.0 or earlier** have an ad-hoc signature, so they can't install a signed update. They read
only the version in `latest-mac.yml` and say a new one is out, and the release notes tell their users to
install the first signed version by hand. That copy then updates itself.

A Mac update needs two signed versions, so the first real test of one is the second signed release: check
that a Mac with the first signed version installs it.

Every published release reaches everyone within a few hours, and you can't take it back from copies that
have already updated. If a release is broken, publish a fixed one with a higher version.

## FFmpeg

The installers contain FFmpeg under the GPL version 3, so its source has to stay available to anyone who
gets them. `licenses/FFMPEG.md` and `.github/release-notes.md` link to the source of the exact builds, and
both need updating when FFmpeg changes.

- **Windows** uses the binaries from the `ffmpeg-ffprobe-static` npm package.
- **macOS** can't. That package's Mac binaries were compiled with `--enable-nonfree`, which FFmpeg defines
  as not redistributable. `scripts/mac-ffmpeg.mjs` swaps in Jellyfin's GPL build whenever a Mac app is
  packed, and the **Build** workflow fails if a non-free FFmpeg ends up in one.

To move to a newer Jellyfin build, change `VERSION` and both `sha256` values in `scripts/mac-ffmpeg.mjs`.
The hashes are on the [release's assets](https://github.com/jellyfin/jellyfin-ffmpeg/releases).

On a Mac, FFmpeg and FFprobe run as programs of their own, so notarisation requires each one to be signed
with the Developer ID, the hardened runtime and a secure timestamp. electron-builder signs them where the
app runs them from, in `app.asar.unpacked`. It would also give them Electron's entitlements, which loosen
the hardened runtime and allow the camera and microphone. They need none of that, and they read every file
people import, so `scripts/sign-mac.mjs` gives them `build/entitlements.ffmpeg.plist`, which allows
nothing. The **Build** workflow checks their signatures and runs each one as it ships.
