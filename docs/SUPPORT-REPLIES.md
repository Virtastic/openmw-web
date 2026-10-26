# Saved replies

Copy-paste answers for the install questions that keep coming up. Each one points at
[`INSTALLING.md`](../INSTALLING.md) rather than repeating it, so fix the page, not the reply.

## "I don't want SSL" / "Can I run it without HTTPS?"

> You can run the server without SSL. Browsers just won't start the *game* unless the page is
> on `https://` or `http://localhost`. The engine needs browser features that are locked to
> secure pages, and no server setting can change that.
>
> - **Only playing on that machine?** Use `docker-compose.simple.yml` and open
>   `http://localhost:8080`. No certificates involved.
> - **Already have nginx, Traefik, Caddy or a Cloudflare Tunnel?** Use
>   `docker-compose.simple.yml`, choose "Internal or behind your own proxy" in the wizard, and
>   let your proxy handle HTTPS. There's a recipe for each one here:
>   https://github.com/Virtastic/openmw-web/blob/main/INSTALLING.md#3-behind-your-own-proxy
>
> A plain `http://<ip>:<port>` link for other players can't work, whatever the server does.

## "Can I run it on Pterodactyl / Pelican?"

> Yes, there's an egg: `pterodactyl/egg-openmw-web.json`. Setup and limits are here:
> https://github.com/Virtastic/openmw-web/blob/main/pterodactyl/README.md
>
> The panel doesn't give you HTTPS, so for other players to join, put a proxy with a
> certificate in front of the allocation's port (recipes:
> https://github.com/Virtastic/openmw-web/blob/main/INSTALLING.md#3-behind-your-own-proxy).
> Give it ~4 GB RAM for multiplayer and ~15 GB disk if you'll add Tamriel Rebuilt.

## "It works on the script but not behind my proxy"

> That's almost always one of these:
>
> 1. the game loads but never connects → WebSocket upgrades aren't forwarded;
> 2. uploads fail with `413` → raise the proxy's body limit to 100 MB (nginx defaults to 1 MB);
> 3. sign-in loops → the proxy isn't sending `X-Forwarded-Proto: https`.
>
> The checklist and configs are here:
> https://github.com/Virtastic/openmw-web/blob/main/INSTALLING.md#3-behind-your-own-proxy
> If it's still stuck, send your proxy config, the browser console (F12 → Console) and
> `docker compose logs --tail 100 openmw-web`.

## "Can you support <Unraid / Kubernetes / my platform>?"

> The server is one Docker image (`ghcr.io/virtastic/openmw-web-server`) on one port, so it
> runs anywhere Docker does. We actively test the script, the compose files and the
> Pterodactyl egg. Other platforms are community-maintained: if you get it working, a PR
> with your recipe for `INSTALLING.md` is very welcome. The proxy rules in section 3 apply
> everywhere.
