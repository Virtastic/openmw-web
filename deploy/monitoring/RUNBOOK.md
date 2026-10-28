# Page runbook

One section per rule in [alerts.yml](alerts.yml). Each says what the page means, what to look
at first and how to stage it on a test box (OT3-140 acceptance: every rule fires once on
purpose before launch).

## ServerDown
The server stopped answering scrapes: crashed, hung, or the container is gone.
First: `docker ps -a`, then `docker logs --tail 200` on the server container. A restart loop
shows in the container's restart count.
Stage: `docker stop` the server container; fires after 1 min.

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
An outside probe (front page, /healthz or the /w/ WebSocket handshake) failed for 2 min.
First: is ServerDown firing too? If not, the proxy (Caddy) or TLS is the suspect.
Stage: `docker stop` the world container.

## DiskLow
Under 15% free. At 0 bytes deploys die and SQLite writes fail.
First: `docker system df`; prune unused images and builder cache.
Stage: `fallocate` a large file on the test box.

## BackupStale
No good SQLite backup in over 2 h. BackupNeverRan is the same page for a process that has
not made its first one in 2 h; both link here.
First: the server log for backup errors; disk space; the backup target's credentials.
Stage: point the backup target at a path that does not exist.

## Not covered yet
- Peer frame p99 > 50 ms: the sim peer does not export frame times. Needs a peer-side metric
  (frame-time histogram reported up the peer socket) before a rule can be written.
