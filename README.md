# Ricochet

A Ricochet Robots puzzle game for Android. Solo play works fully offline.

- The boards of the original game: its eight quadrant faces, combined and rotated at random
- Optional fifth silver robot, and robots with their own hair and expressions
- An exact solver that knows the fewest moves for every target
- Three-step hints: best move count, robots involved, next move
- Every distinct best solution, replayable step by step on the board
- A daily puzzle (five targets, the same for everyone that day) with a streak counter
- Unlimited practice boards at easy, medium or hard difficulty, optionally with bidding
- A per-target timer (one minute by default, adjustable or off)
- Play with a friend over the internet: share a five-letter code, bid, and prove your bid

Multiplayer needs no account or server of our own. Phones find each other through HiveMQ's
free public MQTT broker and then talk directly over WebRTC where the network allows it.

## Install

Download `ricochet.apk` from the [latest release](https://github.com/Hannemit/ricochet/releases/latest)
on your phone and open it. Android will ask you to allow installs from your browser or file manager.

## Build

Requires JDK 17 and the Android SDK (platform 35).

```
./gradlew assembleRelease     # app/build/outputs/apk/release/app-release.apk
node tests/solver.test.js     # checks the solver against brute force
node tests/net.test.js        # checks the multiplayer relay is reachable (needs internet)
```

The game itself is a plain web page in `app/src/main/assets/www`, hosted in a WebView.
Serve that folder with any static file server to play it in a desktop browser.

## Credits

The quadrant layouts in `board.js` follow the transcription of the original boards in
Michael Fogleman's [Ricochet](https://github.com/fogleman/Ricochet) solver.
