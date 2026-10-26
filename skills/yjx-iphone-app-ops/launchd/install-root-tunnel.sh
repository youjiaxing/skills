#!/bin/zsh
set -euo pipefail

skill_dir=${0:A:h:h}
source_plist="$skill_dir/launchd/com.yjx.iphone-tunnel.plist"
target_plist=/Library/LaunchDaemons/com.yjx.iphone-tunnel.plist
node_bin=/Users/youjiaxing/.nvm/versions/node/v22.18.0/bin/node
tunnel_script=/Users/youjiaxing/.appium/node_modules/appium-xcuitest-driver/scripts/tunnel-creation.mjs
device_udid=${IOS_DEVICE_UDID:-00008020-000B25990204002E}
tunnel_endpoint="http://127.0.0.1:42314/remotexpc/tunnels/$device_udid?waitMs=1000"

if [[ ! -f "$source_plist" || ! -x "$node_bin" || ! -f "$tunnel_script" ]]; then
  print -u2 'Tunnel launchd prerequisites are missing.'
  exit 1
fi

plutil -lint "$source_plist"
print -u2 -n 'Requesting administrator authorization (enter the Mac password if prompted)... '
sudo -p 'Mac administrator password: ' -v
print -u2 'authorized.'
sudo install -o root -g wheel -m 644 "$source_plist" "$target_plist"

# Disable an already loaded KeepAlive job before stopping its child process.
# Otherwise launchd immediately respawns the tunnel while this migration waits.
if sudo launchctl print system/com.yjx.iphone-tunnel >/dev/null 2>&1; then
  sudo launchctl bootout system/com.yjx.iphone-tunnel
fi

for pid in ${(f)$(pgrep -f '[t]unnel-creation\.mjs' || true)}; do
  [[ "$pid" == "$PPID" || "$pid" == "$$" ]] && continue
  sudo kill -TERM "$pid" 2>/dev/null || true
done

for attempt in {1..100}; do
  if ! pgrep -f '[t]unnel-creation\.mjs' >/dev/null; then
    break
  fi
  sleep 0.1
done

if pgrep -f '[t]unnel-creation\.mjs' >/dev/null; then
  for pid in ${(f)$(pgrep -f '[t]unnel-creation\.mjs' || true)}; do
    sudo kill -KILL "$pid" 2>/dev/null || true
  done
fi

sudo launchctl bootstrap system "$target_plist"
sudo launchctl enable system/com.yjx.iphone-tunnel

for attempt in {1..120}; do
  if pgrep -f '[t]unnel-creation\.mjs' >/dev/null && /usr/bin/curl -fsS --max-time 2 "$tunnel_endpoint" 2>/dev/null | /usr/bin/grep -q '"status":"OK"'; then
    sudo launchctl print system/com.yjx.iphone-tunnel | /usr/bin/sed -n -E '/state =|pid =|program =/p'
    print "Tunnel registry is ready for $device_udid."
    exit 0
  fi
  sleep 0.1
done

print -u2 "LaunchDaemon loaded, but tunnel registry is not ready for $device_udid. Inspect /var/log/yjx-iphone-tunnel.error.log and restore CoreDevice pairing."
exit 1
