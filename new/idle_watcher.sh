#!/bin/bash

# Enable Bash debugging (prints each command before execution)
set -x

CONTAINER_NAME=$(hostname)
CHECK_INTERVAL=5
IDLE_MINUTES=1
LOG_FILE="/var/log/idle_watcher.log"

echo "[Debug][IdleWatcher] Monitoring SSH activity for $CONTAINER_NAME (user: $(whoami))" | tee -a "$LOG_FILE"

while true; do
  echo "[Debug] Checking active SSH sessions for user $(whoami) at $(date)" | tee -a "$LOG_FILE"

  # Only count sshd processes for the user, ignoring the main daemon
  SSH_PIDS=$(pgrep -u "$(whoami)" sshd | while read pid; do
      CMD=$(ps -p "$pid" -o cmd=)
      # Ignore the main listener daemon
      if [[ "$CMD" != *"[listener]"* && "$CMD" != *"-D"* ]]; then
          echo "$pid"
      fi
  done | tr '\n' ' ')

  if [ -n "$SSH_PIDS" ]; then
      echo "$(date): User $(whoami) active (PIDs: $SSH_PIDS)" | tee -a "$LOG_FILE"
  else
      echo "$(date): No active SSH sessions for $(whoami). Waiting $IDLE_MINUTES minute(s)..." | tee -a "$LOG_FILE"
      sleep $((IDLE_MINUTES * 60))

      # Check again after idle wait
      SSH_PIDS=$(pgrep -u "$(whoami)" sshd | while read pid; do
          CMD=$(ps -p "$pid" -o cmd=)
          if [[ "$CMD" != *"[listener]"* && "$CMD" != *"-D"* ]]; then
              echo "$pid"
          fi
      done | tr '\n' ' ')

      if [ -z "$SSH_PIDS" ]; then
          echo "$(date): Removing container $CONTAINER_NAME (idle)" | tee -a "$LOG_FILE"
          echo "[Debug] Running: curl -s -X DELETE \"http://host.docker.internal:8000/containers/remove/$CONTAINER_NAME\"" | tee -a "$LOG_FILE"
          CURL_OUTPUT=$(curl -s -w "\nHTTP_CODE:%{http_code}" -X DELETE "http://host.docker.internal:8000/containers/remove/$CONTAINER_NAME")
          echo "[Debug] curl output: $CURL_OUTPUT" | tee -a "$LOG_FILE"
          echo "[Debug] Container removal request sent. Exiting script." | tee -a "$LOG_FILE"
          exit 0
      else
          echo "[Debug] SSH session detected after idle wait. Continuing monitoring..." | tee -a "$LOG_FILE"
      fi
  fi

  sleep "$CHECK_INTERVAL"
done
