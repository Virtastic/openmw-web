# Running OpenMW-Web on Pterodactyl

`egg-openmw-web.json` runs the multiplayer server image (`ghcr.io/virtastic/openmw-web-server`)
under a Pterodactyl panel. Before you start, you need:

- A domain with HTTPS in front of the server. The game will not start over plain http.
- About 4 GB of RAM for the server, plus about 1 GB for each extra world that is busy at the same time.
- The Morrowind game files (Morrowind, Tribunal, Bloodmoon). They are uploaded later, from the dashboard.

## 1. Import the egg (panel admin)

1. Go to **Admin → Nests**, create a nest (for example "Browser games") or pick an existing one.
2. Click **Import Egg**, choose `egg-openmw-web.json` and select that nest.

## 2. Give the server a /client mount (panel admin)

The server serves the browser game from `/client`, and Pterodactyl only mounts
`/home/container` unless told otherwise.

1. On the Wings node, make a folder that the container user can write to:
   ```bash
   sudo mkdir -p /srv/openmw-web/client && sudo chown 988:988 /srv/openmw-web/client
   ```
   988 is Wings' default container user. Use `system.user.uid` from `/etc/pterodactyl/config.yml` if you changed it.
2. Go to **Admin → Mounts → Create**:
   - **Source:** `/srv/openmw-web/client`
   - **Target:** `/client`
   - **Read only:** no
   - **User mountable:** no
3. Open the mount and attach it to the OpenMW-Web egg and to your node.

If you run more than one OpenMW-Web server, give each one its own source folder and its own mount.

## 3. Create the server

1. Go to **Admin → Servers → Create**. Pick the OpenMW-Web egg and one port allocation. Give it at least 4096 MB of memory and 10 GB of disk.
2. On images before 1.7.6, set **Listen port** to the allocation's port. On 1.7.6 and later, leave it empty.
3. Under the server's **Mounts** tab, add the `/client` mount.
4. Start the server. It is ready when the console prints a `gateway.start` line.

## 4. Put HTTPS in front

Point a domain at the node and proxy it to `http://<node-ip>:<allocation-port>`. The proxy needs
**WebSocket upgrade** on every path (players connect on `/w/...`). Keep request bodies large:
game-file uploads are hundreds of MB.

Example in Caddy (it gets the certificate itself):
```
play.example.com {
    reverse_proxy 127.0.0.1:25600
}
```

Example in nginx: a normal `proxy_pass` plus these lines:
- `proxy_http_version 1.1;`
- `proxy_set_header Upgrade $http_upgrade;`
- `proxy_set_header Connection "upgrade";`
- `client_max_body_size 0;`
- `proxy_read_timeout 1h;`

Pass the server's own response headers through unchanged. It sends the cross-origin isolation
headers the game needs, so don't strip or override them in the proxy.

## 5. Finish in the dashboard

1. Open `https://<your-domain>/admin`. The setup wizard runs on first visit: choose **multiplayer**.
2. Upload the game files.
3. Click **Install the game client**. It is written to the `/client` mount.
4. In the panel's file manager, edit `config.toml` for the invite code, the server name and so on.
   Restart from the panel afterwards.

## Notes

- The dashboard's restart button stops the process. Pterodactyl brings it back only if the
  server's crash detection is on.
- The panel console is output only: the server reads no commands from it.
- To update, change the image tag under the server's **Startup** tab, then restart.
