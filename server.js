const express = require("express");
const Docker = require("dockerode");

const app = express();
const docker = new Docker({ socketPath: "/var/run/docker.sock" });

const PORT = 8000;
const SSH_PORTS = [22001, 22002, 22003];
const SSH_USER = "tanu";
const SSH_PASS = "123";

app.use(express.json());

// Helper: get a free port
async function getFreePort() {
  const containers = await docker.listContainers({ all: true });
  const usedPorts = containers
    .map((c) => (c.Ports && c.Ports[0] ? c.Ports[0].PublicPort : null))
    .filter(Boolean);
  for (const p of SSH_PORTS) if (!usedPorts.includes(p)) return p;
  return null;
}

// Helper: ensure image exists
async function ensureImage(imageName) {
  try {
    await docker.getImage(imageName).inspect();
  } catch {
    console.log(`Image ${imageName} not found locally. Pulling...`);
    await new Promise((resolve, reject) => {
      docker.pull(imageName, (err, stream) => {
        if (err) return reject(err);
        docker.modem.followProgress(stream, (err) =>
          err ? reject(err) : resolve()
        );
      });
    });
  }
}

// Create container
app.post("/containers/create/:name", async (req, res) => {
  const name = req.params.name;

  try {
    // Check if container exists
    try {
      await docker.getContainer(name).inspect();
      return res.status(400).json({ error: "Container already exists" });
    } catch {}

    const port = await getFreePort();
    if (!port)
      return res.status(400).json({ error: "No free SSH ports available" });

    await ensureImage("ubuntu:22.04"); // pull Ubuntu if needed

    // Idle watcher script
    const idleWatcherScript = `
#!/bin/bash

API_URL="http://host.docker.internal:8000/containers/remove"
CONTAINER_NAME=$(hostname)
CHECK_INTERVAL=5
IDLE_MINUTES=1
LOG_FILE="/var/log/idle_watcher.log"

echo "[IdleWatcher] Monitoring SSH activity for $CONTAINER_NAME" >> "$LOG_FILE"

while true; do
  if pgrep -u ${SSH_USER} sshd >/dev/null; then
    echo "$(date): User is logged in" >> "$LOG_FILE"
  else
    echo "$(date): No active SSH sessions. Waiting $IDLE_MINUTES minute(s)..." >> "$LOG_FILE"
    sleep $((IDLE_MINUTES * 60))
    if ! pgrep -u ${SSH_USER} sshd >/dev/null; then
      echo "$(date): Removing container $CONTAINER_NAME (idle)" >> "$LOG_FILE"
      curl -s -X DELETE "$API_URL/$CONTAINER_NAME"
      exit 0
    fi
  fi
  sleep "$CHECK_INTERVAL"
done
`;

    const container = await docker.createContainer({
      Image: "ubuntu:22.04",
      name,
      Tty: true,
      HostConfig: {
        PortBindings: { "22/tcp": [{ HostPort: port.toString() }] },
        Memory: 512 * 1024 * 1024,
        CpuCount: 1,
        PidsLimit: 100,
        RestartPolicy: { Name: "unless-stopped" },
      },
      Cmd: [
        "/bin/bash",
        "-c",
        `
          apt-get update && \
          DEBIAN_FRONTEND=noninteractive apt-get install -y openssh-server sudo curl && \
          useradd -m -s /bin/bash ${SSH_USER} && \
          echo "${SSH_USER}:${SSH_PASS}" | chpasswd && \
          mkdir -p /var/run/sshd && ssh-keygen -A && \
          echo "PermitRootLogin yes" >> /etc/ssh/sshd_config && \
          echo "PasswordAuthentication yes" >> /etc/ssh/sshd_config && \
          echo "${SSH_USER} ALL=(ALL) NOPASSWD: ALL" >> /etc/sudoers && \
          cat << 'EOF' > /usr/local/bin/idle_watcher.sh
${idleWatcherScript}
EOF
          chmod +x /usr/local/bin/idle_watcher.sh && \
          nohup /usr/local/bin/idle_watcher.sh >/dev/null 2>&1 & \
          /usr/sbin/sshd -D
        `,
      ],
    });

    await container.start();

    res.json({
      message: "Ubuntu SSH container created successfully",
      name,
      status: "running",
      ssh_host_port: port,
      username: SSH_USER,
      password: SSH_PASS,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// List containers
app.get("/containers/list", async (req, res) => {
  try {
    const containers = await docker.listContainers({ all: true });
    const result = [];
    containers.forEach((c) => {
      if (c.Names[0].includes("ssh")) {
        result.push({
          name: c.Names[0].replace("/", ""),
          status: c.State,
          ssh_host_port: c.Ports[0] ? c.Ports[0].PublicPort : null,
          username: SSH_USER,
          password: SSH_PASS,
        });
      }
    });
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Remove container
app.delete("/containers/remove/:name", async (req, res) => {
  const name = req.params.name;
  try {
    const container = docker.getContainer(name);
    await container.remove({ force: true });
    res.json({ message: `Container ${name} removed` });
  } catch (err) {
    res.status(404).json({ error: "Container not found" });
  }
});

app.listen(PORT, () => {
  console.log(`Node SSH sandbox API running on port ${PORT}`);
});
