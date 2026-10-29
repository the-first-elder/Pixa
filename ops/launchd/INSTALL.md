# Pixa always-on (this Mac is the server)

Three LaunchAgents keep the site up across crashes and reboots (login required —
user agents, not daemons):

| Agent | Does | Log |
|---|---|---|
| `dev.pixa.server` | `next start` prod server on :3000 | `/tmp/pixa-prod.log` |
| `dev.pixa.tunnel` | supervised quick tunnel + edge re-sync | `/tmp/cf-tunnel.log` |
| `dev.pixa.caffeinate` | `caffeinate -i -s` (no idle/AC sleep) | `/tmp/pixa-caffeinate.log` |

## Install / update

```bash
# 1. Wrapper must live OUTSIDE ~/Documents (launchd EPERM there):
cp scripts/pixa-tunnel-supervised.sh ~/.config/pixa/
# 2. Cloudflare creds for worker re-sync (600 perms, never in repo):
printf 'CLOUDFLARE_API_TOKEN=%s\nCLOUDFLARE_ACCOUNT_ID=%s\n' '<token>' '<account>' > ~/.config/pixa/cloudflare.env
chmod 600 ~/.config/pixa/cloudflare.env
# 3. (Re)load:
for f in ops/launchd/dev.pixa.*.plist; do
  ln -sf "/Users/thefirstelder/Documents/Pixa/$f" "$HOME/Library/LaunchAgents/$(basename $f)"
done
launchctl load ~/Library/LaunchAgents/dev.pixa.server.plist \
               ~/Library/LaunchAgents/dev.pixa.tunnel.plist \
               ~/Library/LaunchAgents/dev.pixa.caffeinate.plist
launchctl list | grep pixa   # all three show a PID (not "-")
```

After editing a plist: `launchctl unload <plist> && launchctl load <plist>`.

## Known limits (honest)

- **Lid-closed sleep still sleeps the Mac.** `caffeinate` cannot override the lid switch. Keep the lid open (or docked with display sleep allowed, system sleep prevented).
- **Quick-tunnel URLs rotate** on every tunnel restart. The supervised wrapper re-runs `scripts/sync-tunnel.sh` automatically when credentials exist; otherwise run it by hand.
- **Permanent URL = named tunnel**, which needs a token with Zero Trust → Tunnels:Edit (current token lacks it). Until then, `pixa.autumn-test.workers.dev` stays but its ORIGIN follows the tunnel.
- **Reboot**: agents have RunAtLoad, so everything returns on login. The tunnel gets a fresh URL and self-syncs.
- **Data**: reconstruction artifacts live under `data/` (persistent) since the `/tmp/wl-real3` migration (2026-10-29). Scenes whose poses evaporated with `/tmp/wl-real1` (Tester room) and the pruned `job_8c641eb0`/`job_78ebdce5` workdirs (User scene 4, User scene 5) still render from their splats but cannot re-register until re-reconstructed.
