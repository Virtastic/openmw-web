# Monitoring

Everything that tells someone the hosted world is broken, and how it is wired. The pages each
rule sends are explained in [RUNBOOK.md](RUNBOOK.md).

| file | runs where | ticket |
|---|---|---|
| `agent/prometheus-agent.yml` | on the box: scrapes the gateway's `/metrics` and node_exporter, remote_writes off-box | OT3-133 |
| `docker-compose.monitoring.yml` | on the box: the agent and node_exporter, layered over the main compose file | OT3-133 |
| `alertmanager.yml` | the hosted Alertmanager: `severity=page` pages, `severity=ticket` opens a ticket | OT3-133 |
| `alerts.yml` | the hosted ruler: page rules (+ ProberSilent ticket) | OT3-140, OT3-136 |
| `tickets.yml` | the hosted ruler: ticket rules (`severity=ticket`) | OT3-143 |
| `probes/` | a small box OUTSIDE OVH: blackbox_exporter + agent probing the public site | OT3-136 |

## On-box agent and hosted backend (OT3-133)

The server's in-process notifier dies with the process, so a dead server used to be silent. Now
a Prometheus **agent** on the box scrapes the gateway's `/metrics` (on the compose network,
never through Caddy, which keeps `/metrics` off the internet) and node_exporter, and
remote_writes every 15 s to a hosted Prometheus-compatible backend. The backend stores the
series, evaluates the rule files in its ruler and runs Alertmanager. `ServerDown` is
`up == 0 or absent(up)`, evaluated off-box, so it fires when the process dies and also when the
whole box or the agent does.

### Turning it on (owner)

1. **The one manual step: create the hosted backend.** Any service that takes Prometheus
   remote_write and runs a ruler with Alertmanager works (Grafana Cloud, a self-run
   Mimir/Prometheus off OVH, ...). From it, note the remote_write URL, a username/instance id,
   and an API key with metrics write. Upload `alerts.yml` and `tickets.yml` to its ruler
   and `alertmanager.yml` to its Alertmanager, replacing the two `*.invalid` webhook URLs with
   the pager integration and the ticket/chat webhook.
2. On the box, in the checkout:
   - replace `https://REMOTE-WRITE-URL.invalid/...` in `agent/prometheus-agent.yml` with the
     backend's URL;
   - write `deploy/monitoring/secrets/remote_write_user`, `remote_write_key` and
     `metrics_token` (one line each; the directory is gitignored). The metrics token is a long
     random string, e.g. `openssl rand -hex 32`;
   - in the server's `data/config.toml`, set `[metrics] enabled = true` and
     `token = "<the same metrics_token>"`, then restart the server.
3. `docker compose -f docker-compose.yml -f deploy/monitoring/docker-compose.monitoring.yml up -d`

### Checking it (acceptance)

- Metrics visible off-box within a minute: query `up{job="omwmp"}` and
  `omwmp_sessions_in_world` in the backend; the agent's own `prometheus_remote_storage_*`
  series show the send lag.
- `docker stop openmw-web` on a test box: `ServerDown` fires from the hosted Alertmanager
  within about 2 min (1 min `for:` plus scrape and evaluation intervals).

### mp-health.py

`deploy/mp-health.py` read `/var/log/openmw-mp/openmw-mp.log`, which nothing writes on the v2
box. It now reads the logs the server writes itself: `<data>/logs/server.log` (gateway) and
`<data>/worlds/*/logs/server.log` (worlds), and fails loudly when it finds none:

    ssh <box> 'python3 - --hours 24 --data <checkout>/data' < deploy/mp-health.py

## Outside probes (OT3-136)

Once a minute, from outside OVH, `probes/` checks `https://morrowind.virtastic.app/`, `/worlds`
and a `/w/vvardenfell` WebSocket handshake (must answer 101), and remote_writes the results to
the same hosted backend. `ProbeDown` (alerts.yml) pages after two failures in a row, about
2 min after the site stops answering. `ProberSilent` opens a ticket if the prober itself goes
quiet. Only the virtastic host is probed; opentes3.com is added when the owner moves it.

`/healthz` is not probed from outside: the Caddyfile keeps it (with `/metrics` and `/status`)
off the internet. `/worlds` is served by the same gateway process, and the on-box agent covers
`/healthz`'s process as `up{job="omwmp"}`. To probe `/healthz` literally, add it to the
`@gateway` matcher in the Caddyfile first.

**The one manual step:** get a small box (or a free-tier VM) at any provider other than OVH,
copy `probes/` to it, fill `probes/secrets/remote_write_user` and `remote_write_key` and the
remote_write URL as in OT3-133, then `docker compose -f docker-compose.probes.yml up -d`.
A hosted synthetic-monitoring service that emits `probe_success{job="probe"}` works too.

Acceptance: `docker stop openmw-web` on the box pages within about 2 min. Stop the container,
not the world process: the ws probe's dial revives a stopped world, like a player's would.

### Validating the files

No promtool on the laptop; run it from the images:

    docker run --rm -v $PWD/deploy/monitoring:/m --entrypoint promtool prom/prometheus:v3.5.0 check rules /m/alerts.yml /m/tickets.yml
    docker run --rm -v $PWD/deploy/monitoring:/m -w /m --entrypoint promtool prom/prometheus:v3.5.0 test rules alerts.test.yml tickets.test.yml
    docker run --rm -v $PWD/deploy/monitoring/probes/blackbox.yml:/b.yml prom/blackbox-exporter:v0.27.0 --config.file=/b.yml --config.check
    docker run --rm -v $PWD/deploy/monitoring:/m --entrypoint amtool prom/alertmanager:v0.28.1 check-config /m/alertmanager.yml
