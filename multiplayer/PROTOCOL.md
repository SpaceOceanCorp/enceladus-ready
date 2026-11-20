# Enceladus shared world: relay protocol v1

One small relay (`server.mjs`) links everyone who is on or above Enceladus: people on the web globe
(https://enceladus.spaceoceancorp.com, Land and Fly) and players of the Unreal game (through the M2EBridge plugin).
Each client sends where it is a few times a second. The relay sends every client the other players near it, ten times a
second. Nothing is stored and no IP addresses or accounts are passed on.

Transport: WebSocket, one JSON object per text message, at most 1 KB, at most 30 messages a second per client.

## The shared map (both sides must agree on this)

| Field | Meaning |
|---|---|
| `lat` | Planetocentric latitude, degrees, −90 (south pole) to 90 |
| `lon` | Longitude, degrees **east**, −180 to 180. 0° is the meridian facing Saturn (Saturn hangs overhead at 0°, 0°) |
| `h` | Height in metres above a **sphere of radius 252,100 m** centred on Enceladus. This is not height above the ground: the ground itself sits between about −5,000 and +5,000 m on this scale (triaxial shape plus Cassini relief) |
| `hd` | Heading, degrees clockwise from north, of the ship's nose (or the walker's facing) |
| `pt` | Pitch, degrees, nose above the local horizon (+) or below (−), −90 to 90 |
| `rl` | Roll, degrees, right side down (+), −180 to 180 |
| `spd` | Speed, m/s (for effects; positions are what matter) |
| `mode` | `ship`, `walk`, `rover`, `skim` or `orbit` |

The terrain is the Schenk & McKinnon (2024) Cassini DEM (LPI/USRA, via USGS). Its heights are measured from a triaxial
ellipsoid of 256.2 × 251.4 × 248.6 km with the long axis at 4.15° W; the web globe converts them to heights above the
252,100 m sphere, and so must anything that wants its ground to line up.

Attitude (`hd`, `pt`, `rl`) is relative to the local east-north-up frame at the player's position, applied in that order
(turn to heading, then pitch the nose, then roll about the nose). From them, with E, N, U the local east, north and up
unit vectors:

```
level forward  F0 = sin(hd) E + cos(hd) N        level right  R0 = cos(hd) E − sin(hd) N
nose           F  = cos(pt) F0 + sin(pt) U       top after pitch  U1 = −sin(pt) F0 + cos(pt) U
right          R  = cos(rl) R0 − sin(rl) U1      top  T = sin(rl) R0 + cos(rl) U1
```

and back again: `hd = atan2(F·E, F·N)`, `pt = asin(F·U)`, `rl = atan2(−R·U, T·U)`.

Body-centred position (metres; X toward 0° N 0° E, Z toward the north pole, right-handed):
`r = 252100 + h; X = r cos(lat) cos(lon); Y = r cos(lat) sin(lon); Z = r sin(lat)`.
Unreal is left-handed, so M2EBridge flips Y (the same convention it already uses for the Orbit hand-off).

## Messages

Client to relay:

```json
{"type":"hello","v":1,"name":"Pilot 4821","client":"web"}
{"type":"state","lat":-81.5,"lon":-30.0,"h":-3100.5,"hd":45.0,"pt":10.0,"rl":0.0,"spd":120.0,"mode":"ship"}
{"type":"name","name":"Gael"}
```

`client` is `web`, `ue5` or `other`. Names are cleaned (letters, numbers, spaces, `_ . -`, 24 characters at most).
Send `hello` once after connecting, then `state` about 5 times a second (at most 30) while you are on or above Enceladus.

Relay to client:

```json
{"type":"welcome","v":1,"id":"3f9a1c22","name":"Pilot 4821","tickMs":100}
{"type":"peers","t":1795135600917,"online":12,"peers":[{"id":"7b...","name":"Gael","client":"ue5","lat":-81.4,"lon":-29.9,"h":-3050,"hd":90,"pt":0,"rl":0,"spd":15,"mode":"ship"}]}
{"type":"left","id":"7b..."}
```

`peers` never includes you, lists at most the 60 nearest players, and arrives every `tickMs`. A player who sends nothing
for 20 s is dropped. Smooth the motion on your side by drawing each player about 250 ms in the past and interpolating
between the last two updates.

## Limits and safety

- Web origins allowed: the Enceladus site and localhost (set `ALLOW_ORIGINS` for others). The Unreal game sends no
  Origin and is allowed.
- 300 players at once by default (`MAX_CLIENTS`). Over that, new connections are told to try later.
- Out-of-range numbers are clamped and malformed messages ignored. The relay keeps nothing on disk.
- Not yet: accounts, chat, kicking or banning, and anti-cheat. Positions are self-reported, so anyone can claim to be
  anywhere. That is fine for showing each other around, not for anything competitive.
