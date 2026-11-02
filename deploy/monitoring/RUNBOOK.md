# Page runbook

One section per rule in [alerts.yml](alerts.yml). Each says what the page means, what to look
at first and how to stage it on a test box (OT3-140 acceptance: every rule fires once on
purpose before launch).

## ServerDown
The server stopped answering scrapes: crashed, hung, or the container is gone.
First: `docker ps -a`, then `docker logs --tail 200` on the server container. A restart loop
shows in the container's restart count.
Stage: `docker stop` the server container; fires after 1 min.

## ProcessRestarted
The server process started again within the last 10 min: a crash that Docker restarted before
a scrape missed it, or a deploy. Silence it in Alertmanager for planned deploys.
First: `docker inspect -f '{{.RestartCount}} {{.State.StartedAt}}' openmw-web`; the tail of
`data/logs/server.log` before the restart (`server.crash` lines from the last-gasp handler).
Stage: `docker kill -s KILL openmw-web` (restart policy brings it back); fires on the next
evaluation once the new process has spawned its sim peer.

## SimPeerCrashing
Three or more sim peer crashes in 15 min. Each restart freezes the region's NPCs.
First: `simpeer.output` / `simpeer.crashed` lines in the world log; `deploy/mp-health.py` peer
errors.
Stage: `pkill -KILL -f openmw` (the headless peer) three times inside the container.

## PeerFrameSlow
A region's sim peer frame interval p99 is over 50 ms (its pace) for 5 min: sim time runs slow
there, so NPCs and combat lag for everyone in the region.
First: `omwmp_peer_active_actors` and `omwmp_peer_held_cells` for the region; box CPU.
Stage: on the test box, `stress-ng --cpu 0` for 6 min with a player in the region.

## EventLoopStalled
Event-loop p99 above 100 ms for 5 min: a sync hot path (big flush, a JSON blob, a regex) is
blocking every socket.
First: the server log around the start time for `persist.*` and slow handlers; CPU on the box.
Stage: a debug build that busy-waits 200 ms on a timer.

## PersistFlushFailed
A flush threw. Player or cell progress since the last good flush may be lost on restart.
First: the `store` label, then the server log for the matching error; disk space (see DiskLow).
Stage: make the data dir read-only on the test box.

## SessionsCollapsed
Half the players dropped in a minute (from 6 or more): a network blip, a crash loop in the
peer, or a bad deploy.
First: `omwmp_disconnects_total` by code over the same minute; ProbeDown firing alongside.
Stage: harness with 6+ bots, then kill the gateway's network for 30 s.

## ProbeDown
An outside probe (front page, /worlds or the /w/ WebSocket handshake; `check` label http or ws)
failed twice running, from the prober outside OVH (probes/).
First: is ServerDown firing too? If not, the proxy (Caddy) or TLS is the suspect.
Stage: `docker stop openmw-web` (the container). Stopping only the world PROCESS does not
work as a test: the ws probe's dial revives it (directory.ts restart-on-dial), as a player's would.

## ProberSilent
Ticket, not a page: the outside prober sent nothing for 10 min, so ProbeDown is blind.
First: the prober box (`docker compose -f docker-compose.probes.yml ps` there), its
remote_write credentials.

## DiskLow
Under 15% free. At 0 bytes deploys die and SQLite writes fail.
First: `docker system df`; prune unused images and builder cache.
Stage: `fallocate` a large file on the test box.

## BackupStale
No good SQLite backup in over 2 h. BackupNeverRan is the same page for a process that has
not made its first one in 2 h; both link here.
First: the server log for backup errors; disk space; the backup target's credentials.
Stage: point the backup target at a path that does not exist.

## Tickets (tickets.yml, OT3-143)
These open a ticket, never a page. Each is a sustained condition, so one incident is one ticket.

### SignupSpike
Sign-ups in the last hour over 5x the 7-day hourly average (and at least 10). A bot wave or a
link going round. First: the `auth.sso_ok` / `frontdoor.*` log lines by IP; invite-code use.

### AuthFailureRate
Over 20% of sign-in attempts failing for 15 min (at least 20 attempts). A provider outage, an
expired OAuth secret, or credential stuffing. First: `omwmp_auth_total` by `op` and `result`;
`auth.sso_failed` codes in mp-health.py.

### AbnormalDisconnects
Over 10% of sessions ending in a server-side drop or keepalive reap over 30 min.
First: `omwmp_disconnects_total` by code; RATE and BACKLOG point at clients, the rest at the
server.

### BackpressureDropsRising
Lossy frames dropped on backed-up sockets at over 1/s and twice the hour before. Clients on bad
links, or the box's outbound falling behind. First: `omwmp_outbound_buffered_bytes`, box
network, `omwmp_backpressure_dropped_total` by `kind`.

### JoinSlow
Join p95 over 30 s for 15 min. First: whether the world is booting or its peer restarting
(`omwmp_simpeer_*`), `omwmp_op_queue_wait_seconds`.

### In-process notifications (notifyFromLog)
The `[notifications]` mail/webhook tap is deduped: the same event (numbers masked) is sent once
per 15 min, the next one carrying `repeats=N`, and no more than 20 go out per hour in total.

## Not covered yet
- A direct process start-time metric: ProcessRestarted infers restarts from counter resets
  until metrics.ts exports `process_start_time_seconds`.
