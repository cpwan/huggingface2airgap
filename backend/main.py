from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from starlette.websockets import WebSocketState
import os
import json
import logging
import subprocess
from fastapi.staticfiles import StaticFiles

app = FastAPI()

# Set up detailed logging
logging.basicConfig(
    level=logging.WARNING,
    format='%(asctime)s - %(levelname)s - %(message)s',
    handlers=[
        logging.FileHandler('./server.log'),
        logging.StreamHandler()
    ]
)
logger = logging.getLogger(__name__)

# Set HF_HOME
cache_dir = os.environ.get('HF_HOME', os.path.expanduser("~/.cache/huggingface/hub"))

# get absolute path of cache_dir

if not os.path.exists(cache_dir):
    os.makedirs(cache_dir, exist_ok=True)
logger.info(f"Using cache directory: {cache_dir}")

@app.websocket("/stream-model")
async def stream_model(websocket: WebSocket):
    logger.debug("WebSocket connection attempt received")
    await websocket.accept()
    logger.info("WebSocket connection accepted")
    
    current_file = None
    file_path = None
    commit_hash_saved = False

    try:
        while True:
            data = await websocket.receive()
            logger.debug(f"Received raw data: {data}"[:1000])
            if data['type'] == 'websocket.disconnect':
                raise WebSocketDisconnect()

            data_type = None
            if data.get('text'):
                data_type = 'text'
            elif data.get('bytes'):
                data_type = 'bytes'
            else:
                logger.warning(f"Unexpected data type received: {data}")
                await websocket.send_text("Error: Unexpected data type")
                continue
            data_content = data.get('text') or data.get('bytes')

            if data_type == 'text':
                try:
                    message = json.loads(data_content)
                    logger.debug(f"Parsed message: {message}")
                except json.JSONDecodeError as e:
                    logger.error(f"Failed to parse JSON: {str(e)}, raw text: {data_content}")
                    await websocket.send_text(f"Error: Invalid JSON - {str(e)}")
                    continue
                
                action = message.get('action')
                if action == 'start':
                    repo_name = message.get('repo_name')
                    file_name = message.get('file_name')
                    commit_hash = message.get('commit_hash')
                    
                    if not all([repo_name, file_name, commit_hash]):
                        logger.error("Missing required metadata")
                        await websocket.send_text("Error: Missing metadata")
                        continue
                    
                    repo_name_modified = repo_name.replace('/', '--')
                    upload_dir = os.path.join(cache_dir, f'models--{repo_name_modified}')
                    snapshot_dir = os.path.join(upload_dir, 'snapshots', commit_hash)
                    
                    os.makedirs(snapshot_dir, exist_ok=True)
                    file_path = os.path.join(snapshot_dir, file_name)
                    
                    logger.debug(f"Constructed file path: {file_path}")
                    try:
                        current_file = open(file_path, 'wb')
                        logger.info(f"Started saving {file_name} to {file_path}")
                        await websocket.send_text(f"Started saving {file_name}")
                    except PermissionError as e:
                        logger.error(f"Permission denied for {file_path}: {str(e)}")
                        await websocket.send_text("Error: Permission denied")
                        raise

                    if not commit_hash_saved:
                        refs_dir = os.path.join(upload_dir, 'refs')
                        os.makedirs(refs_dir, exist_ok=True)
                        refs_file_path = os.path.join(refs_dir, 'main')
                        with open(refs_file_path, 'w') as refs_file:
                            refs_file.write(commit_hash)
                        logger.info(f"Saved commit hash to {refs_file_path}")
                        commit_hash_saved = True
                
                elif action == 'end' and current_file:
                    current_file.close()
                    logger.info(f"Closed file: {file_path}")
                    current_file = None
                    await websocket.send_text(f"Finished saving {file_name}")

            elif data_type == 'bytes' and current_file:
                chunk_size = len(data_content)
                logger.debug(f"Writing chunk of size {chunk_size} bytes to {file_path}")
                current_file.write(data_content)

    except WebSocketDisconnect:
        if current_file:
            current_file.close()
            logger.warning(f"WebSocket disconnected while writing {file_path}")
        logger.info("WebSocket connection closed by client")
    except Exception as e:
        if current_file:
            current_file.close()
            logger.warning(f"File closed due to error: {file_path}")
        logger.error(f"Unexpected error: {str(e)}", exc_info=True)
        if websocket.application_state == WebSocketState.CONNECTED:
            await websocket.send_text(f"Error: {str(e)}")

@app.get("/scan-cache")
async def validate_cache():
    logger.info("Validating cache with huggingface-cli scan-cache")
    try:        
        result = subprocess.run(
            ['huggingface-cli', 'scan-cache'],
            capture_output=True,
            text=True,
            env={**os.environ, 'HUGGINGFACE_HUB_CACHE': cache_dir}
        )
        if result.returncode == 0:
            logger.info("Cache validation successful")
            logger.debug(f"Scan-cache output: {result.stdout}")
            return {"status": "success", "output": result.stdout}
        else:
            logger.error(f"Cache validation failed: {result.stderr}")
            return {"status": "error", "output": result.stderr}
    except Exception as e:
        logger.error(f"Error during cache validation: {str(e)}", exc_info=True)
        return {"status": "error", "message": str(e)}

# Serve frontend files
app.mount("/", StaticFiles(directory="../frontend/out", html=True), name="frontend")

# Run with: uvicorn main:app --host 0.0.0.0 --port 8000