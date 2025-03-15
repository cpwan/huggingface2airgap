# Backend Service

This backend service is built using FastAPI. It provides WebSocket endpoints for streaming model files and an endpoint for validating the cache using `huggingface-cli`.

## Endpoints

- `/stream-model`: WebSocket endpoint for streaming model files.
- `/scan-cache`: GET endpoint for validating the cache.

## Logging

Logs are saved to `./server.log` and also output to the console.

## Running the Service

To run the backend service, use the following command:

```bash
uvicorn main:app --host 0.0.0.0 --port 8000
```

### Alternative: Using `uv` Package Manager

`uv` is a package manager that can be used to manage dependencies and run scripts.

  ```bash
  uv sync # Sync Dependencies
  uv run uvicorn main:app --host 0.0.0.0 --port 8000
  ```

  ```bash
  uv add <new_package> # Add new dependencies
  uv lock # frozen the dependencies
  uv export > requirements.txt # for pip compatibility
  ```
