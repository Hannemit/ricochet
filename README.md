# Ricochet

A Ricochet Robots puzzle game for Android. Works fully offline and needs no permissions.

- Randomly generated 16×16 boards with 17 targets, played round by round
- An exact solver that knows the fewest moves for every target
- Three-step hints: best move count, robots involved, next move
- Every distinct best solution, replayable step by step on the board
- Easy, medium and hard difficulty, light and dark themes

## Install

Download `ricochet.apk` from the [latest release](https://github.com/Hannemit/ricochet/releases/latest)
on your phone and open it. Android will ask you to allow installs from your browser or file manager.

## Build

Requires JDK 17 and the Android SDK (platform 35).

```
./gradlew assembleRelease     # app/build/outputs/apk/release/app-release.apk
node tests/solver.test.js     # checks the solver against brute force
```

The game itself is a plain web page in `app/src/main/assets/www`, hosted in a WebView.
Serve that folder with any static file server to play it in a desktop browser.
