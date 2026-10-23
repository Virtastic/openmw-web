# openmw-web on Pterodactyl / Pelican

An egg that runs the single-player openmw-web server from the published image
(`ghcr.io/virtastic/openmw-web-server`). **Untested on a real Wings node so far.** If you try it,
please report what happened.

## Set up

1. Import `egg-openmw-web.json` (Pterodactyl: Admin > Nests > Import Egg. Pelican: Admin > Eggs > Import).
2. Create a server from it with one allocation and at least 1 GB RAM.
3. Start it and open `http://<node-ip>:<port>/admin`. The setup wizard installs the player app and
   lets you upload your Morrowind files (or drop `Morrowind.esm` and the `.bsa` files into
   `data/gamedata` with the panel file manager).

Saves and config live in `data/`, the player app in `play/`, both under the server's volume.

## HTTPS is required for players

Browsers only start the game on `https://` or `localhost`. The panel does not provide TLS, so put a
reverse proxy with a certificate in front of the allocation. With Caddy:

```
morrowind.example.com {
    reverse_proxy <node-ip>:<port>
}
```

## Limits

- Single-player only. Multiplayer needs a range of extra ports (`OMW_BASE_PORT`), which an egg
  with one allocation cannot provide.
- The image normally starts as root and fixes file ownership; under Wings it runs as the panel's
  unprivileged user instead, so the volume must be writable by that user (it normally is).
