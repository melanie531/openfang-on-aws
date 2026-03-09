set -euo pipefail
exec > >(tee /var/log/openfang-setup.log) 2>&1
echo "=== OpenFang setup started at $(date -u) ==="

# -- 0. Swap space (4GB) for Rust compilation ----------------------
fallocate -l 4G /swapfile
chmod 600 /swapfile
mkswap /swapfile
swapon /swapfile
echo '/swapfile swap swap defaults 0 0' >> /etc/fstab
echo "Swap enabled: $(free -m | grep Swap)"

# -- 1. System packages --------------------------------------------
dnf update -y
dnf install -y docker git openssl

# -- 2. Docker daemon ----------------------------------------------
systemctl enable docker
systemctl start docker
usermod -aG docker ec2-user

# Install Docker Compose v2 plugin
COMPOSE_VERSION="v2.32.4"
mkdir -p /usr/local/lib/docker/cli-plugins
curl -fsSL "https://github.com/docker/compose/releases/download/${COMPOSE_VERSION}/docker-compose-linux-x86_64" \
  -o /usr/local/lib/docker/cli-plugins/docker-compose
chmod +x /usr/local/lib/docker/cli-plugins/docker-compose

# -- 3. OpenFang directory and source ------------------------------
mkdir -p /opt/openfang
cd /opt/openfang

git clone --depth 1 https://github.com/RightNow-AI/openfang.git source

# Patch Dockerfile to include python3-minimal (needed by Researcher Hand
# for platform detection in Phase 0)
sed -i '/apt-get install -y ca-certificates/s/ca-certificates/ca-certificates python3-minimal/' \
  source/Dockerfile

# -- 4. Generate secrets -------------------------------------------
OF_API_KEY=$(openssl rand -hex 32)
LITELLM_KEY=$(openssl rand -hex 32)

# -- 5. LiteLLM config --------------------------------------------
cat > litellm_config.yaml << LITELLM_EOF
model_list:
  - model_name: "bedrock/anthropic.claude-sonnet-4-6"
    litellm_params:
      model: "bedrock/us.anthropic.claude-sonnet-4-6"
      aws_region_name: "__BEDROCK_REGION__"
  - model_name: "bedrock/anthropic.claude-haiku-4-5-20251001"
    litellm_params:
      model: "bedrock/us.anthropic.claude-haiku-4-5-20251001-v1:0"
      aws_region_name: "__BEDROCK_REGION__"
  - model_name: "bedrock/amazon.nova-pro-v1:0"
    litellm_params:
      model: "bedrock/us.amazon.nova-pro-v1:0"
      aws_region_name: "__BEDROCK_REGION__"
  - model_name: "bedrock/amazon.nova-lite-v1:0"
    litellm_params:
      model: "bedrock/us.amazon.nova-lite-v1:0"
      aws_region_name: "__BEDROCK_REGION__"

general_settings:
  master_key: "${LITELLM_KEY}"
LITELLM_EOF

# -- 6. OpenFang config -------------------------------------------
cat > config.toml << OPENFANG_EOF
api_key = "${OF_API_KEY}"

[default_model]
provider = "bedrock"
model = "bedrock/anthropic.claude-sonnet-4-6"
base_url = "http://litellm:4000/v1"
api_key_env = "LITELLM_API_KEY"

[memory]
decay_rate = 0.05

[network]
listen_addr = "0.0.0.0:4200"
OPENFANG_EOF

# -- 7. Docker Compose ---------------------------------------------
cat > docker-compose.yml << COMPOSE_EOF
services:
  openfang:
    build: ./source
    ports:
      - "127.0.0.1:4200:4200"
    volumes:
      - openfang-data:/data
      - ./config.toml:/data/config.toml:ro
    environment:
      - LITELLM_API_KEY=${LITELLM_KEY}
    depends_on:
      litellm:
        condition: service_started
    restart: unless-stopped
    deploy:
      resources:
        limits:
          memory: 2G

  litellm:
    image: ghcr.io/berriai/litellm:main-v1.65.0
    ports:
      - "127.0.0.1:4000:4000"
    volumes:
      - ./litellm_config.yaml:/app/config.yaml:ro
    command: ["--config", "/app/config.yaml", "--port", "4000"]
    environment:
      - AWS_DEFAULT_REGION=__BEDROCK_REGION__
      - LITELLM_MASTER_KEY=${LITELLM_KEY}
    restart: unless-stopped
    deploy:
      resources:
        limits:
          memory: 512M

volumes:
  openfang-data:
COMPOSE_EOF

# -- 8. Build and start containers --------------------------------
docker compose up -d --build

# -- 9. Persist API key for operator reference ---------------------
cat > /opt/openfang/.env << ENV_EOF
OF_API_KEY=${OF_API_KEY}
ENV_EOF
chmod 600 /opt/openfang/.env

# -- 10. Activate Researcher Hand (after containers are healthy) ---
echo "Waiting for OpenFang container to be ready..."
for i in $(seq 1 60); do
  if docker compose exec -T openfang openfang hand list >/dev/null 2>&1; then
    echo "OpenFang is ready."
    docker compose exec -T openfang openfang hand activate researcher || true
    break
  fi
  echo "  attempt ${i}/60 -- waiting 10s..."
  sleep 10
done

echo "=== OpenFang setup finished at $(date -u) ==="
echo "API key saved to /opt/openfang/.env"
echo "Connect via: aws ssm start-session --target $(curl -s http://169.254.169.254/latest/meta-data/instance-id)"
