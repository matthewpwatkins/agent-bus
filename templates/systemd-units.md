# Example systemd units. `agentbus service install` and
# `agentbus setup-messaging` generate these with real paths filled in;
# they are kept here for reference / manual installs.

# --- agentbus-syncthing.service ---
[Unit]
Description=Syncthing (Agent Bus)
After=network.target

[Service]
ExecStart=/path/to/.agentbus/bin/syncthing serve --home=/path/to/.agentbus/syncthing --no-browser --no-restart
Restart=on-failure
RestartSec=5
TimeoutStopSec=10

[Install]
WantedBy=default.target

# --- agentbus-listener-<share>.service ---
[Unit]
Description=Agent Bus listener (<share>)
After=agentbus-syncthing.service network.target

[Service]
Environment=AGENTBUS_HOME=/path/to/.agentbus
ExecStart=/usr/bin/node /path/to/agent-bus/dist/cli.js listen --share <share>
Restart=always
RestartSec=5
TimeoutStopSec=10

[Install]
WantedBy=default.target
