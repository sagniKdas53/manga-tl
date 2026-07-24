#!/bin/bash
export SPRING_DATASOURCE_PASSWORD=$(cat ../secrets/db_password.txt)
export MINIO_SECRET_KEY=$(cat ../secrets/minio_password.txt)
export JWT_SECRET=$(cat ../secrets/jwt_secret.txt)
export INTERNAL_API_TOKEN=$(cat ../secrets/internal_api_token.txt)
export WORKER_API_SECRET=$(cat ../secrets/worker_api_secret.txt)

mvn spring-boot:run -Dspring-boot.run.arguments="--server.port=8081" &
PID=$!
echo "Started Spring Boot with PID $PID"

max_retries=60
count=0
while ! curl -s http://localhost:8081/v3/api-docs > ../docs/api/openapi.json; do
  if [ $count -ge $max_retries ]; then
    echo "Timeout waiting for Spring Boot to start."
    kill $PID
    exit 1
  fi
  echo "Waiting for Spring Boot... ($count/$max_retries)"
  sleep 2
  count=$((count+1))
done

# Format the JSON if jq is available
if command -v jq &> /dev/null; then
    jq . ../docs/api/openapi.json > ../docs/api/openapi.json.tmp
    mv ../docs/api/openapi.json.tmp ../docs/api/openapi.json
fi

echo "Successfully generated OpenAPI spec."
kill -9 $PID
