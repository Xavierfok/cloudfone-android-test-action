# cloudf.one Android phone action

[![test](https://github.com/Xavierfok/cloudfone-android-test-action/actions/workflows/test.yml/badge.svg)](https://github.com/Xavierfok/cloudfone-android-test-action/actions/workflows/test.yml)

A GitHub Action that gives a CI job one of your [cloudf.one](https://cloudf.one/?utm_source=github&utm_medium=repo) phones: a real Android handset in Singapore on a local mobile SIM. It waits for the phone, checks its carrier, and holds the control lock for the job. With the adb tunnel it also installs your APK, launches it, runs your test command against the phone, and saves a screenshot.

It is built on [cloudfone-cli](https://github.com/Xavierfok/cloudfone-cli) and needs no other setup on the runner.

## Two modes

| | reserve (default) | adb |
|---|---|---|
| Needs | an access token | the token, plus the cloudf.one WireGuard tunnel |
| Waits for the phone, checks carrier, holds the lock | yes | yes |
| Installs an APK, launches it, runs your tests, screenshot | no | yes |
| Runners | any | Linux |

The split comes from the platform. cloudf.one's REST API can list and lock phones, but installs, taps and screenshots need adb. adb isn't open to the internet: it only runs through a WireGuard tunnel scoped to your own phone. Right now that tunnel is set up by hand. [Message cloudf.one](https://cloudf.one/developers?utm_source=github&utm_medium=repo) and ask for one.

## Reserve a phone

```yaml
- id: phone
  uses: Xavierfok/cloudfone-android-test-action@v1
  with:
    token: ${{ secrets.CLOUDFONE_TOKEN }}
    carrier: Singtel        # optional: fail if the SIM is on another carrier
- run: echo "testing on ${{ steps.phone.outputs.model }} (${{ steps.phone.outputs.carrier }})"
```

To get the token, log in to cloudf.one, open your phone once, then generate one under `cloudf.one/#!/settings` → **Access tokens**. Store it as the repository secret `CLOUDFONE_TOKEN`.

The lock is released when the job ends, even if it fails. Set `keep-lock: "true"` to keep it. The lock is the same one a browser tab takes, so don't have the phone open in a browser while the job runs.

## Install and test an APK (adb mode)

```yaml
jobs:
  device-test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - run: ./gradlew assembleDebug assembleDebugAndroidTest
      - id: phone
        uses: Xavierfok/cloudfone-android-test-action@v1
        with:
          token: ${{ secrets.CLOUDFONE_TOKEN }}
          wireguard-config: ${{ secrets.CLOUDFONE_WG_CONFIG }}
          adb-host: ${{ secrets.CLOUDFONE_ADB_HOST }}
          adb-key: ${{ secrets.CLOUDFONE_ADB_KEY }}
          apk: app/build/outputs/apk/debug/app-debug.apk
          package: com.example.app
          test-command: ./gradlew connectedDebugAndroidTest
      - if: always() && steps.phone.outputs.screenshot != ''
        uses: actions/upload-artifact@v4
        with:
          name: phone-screenshot
          path: ${{ steps.phone.outputs.screenshot }}
```

`ANDROID_SERIAL` is set for `test-command`, so plain `adb` and Gradle's connected tests target the cloudf.one phone. Other tools can read the same value, or use the `adb-serial` output.

**About the adb key.** A runner makes a fresh adb key every run, and the phone asks "Allow USB debugging?" for each new key. CI can't tap that. So make one key, authorise it once, and reuse it:

1. On your machine: `adb start-server`. That creates `~/.android/adbkey`.
2. With the tunnel up, run `cloudfone add-adb-key` and `cloudfone adb-connect SERIAL --via ADB_HOST --connect`. Then open the phone in the browser and accept the prompt with **Always allow** ticked.
3. Save the contents of `~/.android/adbkey` as the secret `CLOUDFONE_ADB_KEY`.

The tunnel config's `DNS=` line is dropped on the runner, so the tunnel carries adb traffic only.

## Inputs

| input | default | |
|---|---|---|
| `token` | required | cloudf.one access token |
| `serial` | first ready phone | phone to use |
| `carrier` | | fail unless the SIM carrier matches (e.g. `Singtel`, `M1`) |
| `wait-timeout` | `300` | seconds to wait for the phone |
| `lock-minutes` | `30` | idle minutes before the lock drops on its own |
| `keep-lock` | `false` | keep the phone after the job |
| `wireguard-config` | | tunnel config; turns on adb mode |
| `adb-host` | | tunnel address for adb |
| `adb-key` | | authorised private adb key |
| `apk` | | APK to install |
| `package` | | package to launch |
| `launch-wait` | `5` | seconds after launch |
| `test-command` | | shell command run against the phone |
| `screenshot` | `cloudfone-screenshot.png` | screenshot path |

Outputs: `mode`, `serial`, `model`, `carrier`, `android-version`, `network`, `adb-serial`, `test-result`, `screenshot`.

## Worth knowing about the phones

Some settings are enforced on a timer and revert: no screen lock, sideloading only from Play Store / Galaxy Store (adb installs work), Wi-Fi off so traffic uses the SIM. Never set a screen lock or PIN, because that locks the phone out of remote management. The full list is on the [developers page](https://cloudf.one/developers?utm_source=github&utm_medium=repo).

## Pricing

A free 24-hour trial phone when the trial pool has stock, a $5 paid test for 24 hours, or $50/month for a dedicated phone. See [cloudf.one](https://cloudf.one/?utm_source=github&utm_medium=repo).

## License

MIT
