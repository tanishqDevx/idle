require("dotenv").config();
const express = require("express");
const Docker = require("dockerode");

const app = express();
const docker = new Docker({ socketPath: "/var/run/docker.sock" });

const PORT = process.env.PORT || 8000;
const SSH_PORTS = [22001, 22002, 22003];

const SSH_USER = process.env.SSH_DEFAULT_USER || "user";
const SSH_PASS = process.env.SSH_DEFAULT_PASS || "pass";
const API_URL =
  process.env.SSH_API_URL || "http://localhost:8000/containers/remove";

app.use(express.json());

// Get a free port
async function getFreePort() {
  const containers = await docker.listContainers({ all: true });
  const usedPorts = containers
    .flatMap((c) => c.Ports || [])
    .map((p) => p.PublicPort)
    .filter(Boolean);
  for (const port of SSH_PORTS) if (!usedPorts.includes(port)) return port;
  return null;
}

// Ensure image
async function ensureImage(imageName) {
  try {
    await docker.getImage(imageName).inspect();
  } catch {
    console.log(`Pulling missing image ${imageName}...`);
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
  const username = req.body.username || SSH_USER;
  const password = req.body.password || SSH_PASS;

  try {
    try {
      await docker.getContainer(name).inspect();
      return res.status(400).json({ error: "Container already exists" });
    } catch {}

    const port = await getFreePort();
    if (!port) return res.status(400).json({ error: "No free ports" });
    await ensureImage("tanishqdevx/ubuntu_ssh11:v1.8");

    const container = await docker.createContainer({
      Image: "tanishqdevx/ubuntu_ssh11:v1.8",
      name,
      Tty: true,
      Env: [
        `SSH_USER=${username}`,
        `SSH_PASS=${password}`,
        `API_URL=${API_URL}`,
      ],
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
      useradd -m -s /bin/bash $SSH_USER && \
      echo "$SSH_USER:$SSH_PASS" | chpasswd && \
      echo "$SSH_USER ALL=(ALL) NOPASSWD: ALL" >> /etc/sudoers && \
      nohup /usr/local/bin/idle_watcher.sh >/dev/null 2>&1 & \
      /usr/sbin/sshd -D
    `,
      ],
    });

    await container.start();

    res.json({
      message: "Container started successfully",
      container: name,
      ssh_host_port: port,
      username,
      password,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// List & Remove endpoints unchanged
app.get("/containers/list", async (req, res) => {
  try {
    const containers = await docker.listContainers({ all: true });
    const result = containers.map((c) => ({
      name: c.Names[0].replace("/", ""),
      status: c.State,
      ssh_host_port: c.Ports[0]?.PublicPort,
    }));
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Accepts either container ID or name
app.delete("/containers/remove/:containerIdOrName", async (req, res) => {
  const { containerIdOrName } = req.params;
  try {
    const container = docker.getContainer(containerIdOrName);
    await container.remove({ force: true });
    res.json({
      message: `Container '${containerIdOrName}' removed successfully.`,
    });
  } catch (err) {
    res.status(404).json({
      error: `Container '${containerIdOrName}' not found or could not be removed.`,
    });
  }
});

app.listen(PORT, () => console.log(`🚀 API running on port ${PORT}`));
