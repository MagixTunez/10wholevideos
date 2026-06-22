Hi make sure you have the .env configured to ur domain.

Local run:

node client.ts

Docker run:

1. Build and start

docker compose up --build

2. Stop

docker compose down

Notes:

1. Container listens on port 5181.
2. `./media` and `./live` are mounted into the container.
3. `./.env` is mounted read-only into the container.
