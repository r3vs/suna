import os
from typing import Optional
import uuid
import httpx

from daytona_sdk import Daytona, DaytonaConfig, CreateSandboxParams, Sandbox, SessionExecuteRequest
from daytona_api_client.models.workspace_state import WorkspaceState
from dotenv import load_dotenv

from agentpress.tool import Tool
from utils.logger import logger
from utils.config import config
from utils.files_utils import clean_path
from agentpress.thread_manager import ThreadManager

load_dotenv()

logger.debug("Initializing Daytona sandbox configuration")

daytona_config = DaytonaConfig(
    api_key=config.DAYTONA_API_KEY,
    server_url=config.DAYTONA_SERVER_URL,
    target=config.DAYTONA_TARGET
)

if daytona_config.api_key:
    logger.debug("Daytona API key configured successfully")
else:
    logger.warning("No Daytona API key found in environment variables")

if daytona_config.server_url:
    logger.debug(f"Daytona server URL set to: {daytona_config.server_url}")
else:
    logger.warning("No Daytona server URL found in environment variables")

if daytona_config.target:
    logger.debug(f"Daytona target set to: {daytona_config.target}")
else:
    logger.warning("No Daytona target found in environment variables")

daytona = Daytona(daytona_config)
logger.debug("Daytona client initialized")

async def get_or_start_sandbox(sandbox_id: str):
    """Retrieve a sandbox by ID, check its state, and start it if needed."""
    
    logger.info(f"Getting or starting sandbox with ID: {sandbox_id}")
    
    try:
        sandbox = daytona.get_current_sandbox(sandbox_id)
        
        # Check if sandbox needs to be started
        if sandbox.instance.state == WorkspaceState.ARCHIVED or sandbox.instance.state == WorkspaceState.STOPPED:
            logger.info(f"Sandbox is in {sandbox.instance.state} state. Starting...")
            try:
                daytona.start(sandbox)
                # Wait a moment for the sandbox to initialize
                # sleep(5)
                # Refresh sandbox state after starting
                sandbox = daytona.get_current_sandbox(sandbox_id)
                
                # Start supervisord in a session when restarting
                start_supervisord_session(sandbox)
            except Exception as e:
                logger.error(f"Error starting sandbox: {e}")
                raise e
        
        logger.info(f"Sandbox {sandbox_id} is ready")
        return sandbox
        
    except Exception as e:
        logger.error(f"Error retrieving or starting sandbox: {str(e)}")
        raise e

def start_supervisord_session(sandbox: Sandbox):
    """Start supervisord in a session."""
    session_id = "supervisord-session"
    try:
        logger.info(f"Creating session {session_id} for supervisord")
        sandbox.process.create_session(session_id)
        
        # Execute supervisord command
        sandbox.process.execute_session_command(session_id, SessionExecuteRequest(
            command="exec /usr/bin/supervisord -n -c /etc/supervisor/conf.d/supervisord.conf",
            var_async=True
        ))
        logger.info(f"Supervisord started in session {session_id}")
    except Exception as e:
        logger.error(f"Error starting supervisord session: {str(e)}")
        raise e

async def create_sandbox(password: str, project_id: str = None):
    """Create a new sandbox with all required services configured and running."""
    
    logger.debug("Creating new Daytona sandbox environment")
    logger.debug("Configuring sandbox with browser-use image and environment variables")
    
    current_sandbox_id = project_id or str(uuid.uuid4())
    sandbox_name = f"Sandbox-{current_sandbox_id[:8]}"
    
    env_vars_payload = {
        "CHROME_PERSISTENT_SESSION": "true",
        "RESOLUTION": "1024x768x24",
        "RESOLUTION_WIDTH": "1024",
        "RESOLUTION_HEIGHT": "768",
        "VNC_PASSWORD": password,
        "ANONYMIZED_TELEMETRY": "false",
        "CHROME_PATH": "",
        "CHROME_USER_DATA": "",
        "CHROME_DEBUGGING_PORT": "9222",
        "CHROME_DEBUGGING_HOST": "localhost",
        "CHROME_CDP": ""
    }

    params = CreateSandboxParams(
        name=sandbox_name,
        target_id=daytona_config.target,
        image="adamcohenhillel/kortix-suna:0.0.20", # This is the image used by default
        env_vars=env_vars_payload,
        # TODO: Add labels, resources if needed
        # 'public': True, # Example, if public sandboxes are desired
        # 'labels': {"owner": "suna-agent", "project_id": current_sandbox_id},
        # 'resources': {'cpu': '1', 'memory': '2Gi'} # Example resource limits
    )
    logger.debug(f"Creating workspace with SDK params: {{'name': '{params.name}', 'target_id': '{params.target_id}', 'image': '{params.image}'}}")

    try:
        new_sandbox = daytona.create(params)
        logger.info(f"Workspace {new_sandbox.id} created successfully with image {params.image}")
        
        # Start supervisord in a session for new sandbox
        start_supervisord_session(new_sandbox)
        
        logger.debug(f"Sandbox environment {new_sandbox.id} successfully initialized")
        return new_sandbox

    except Exception as e:
        logger.error(f"Error during Daytona workspace creation: {str(e)}")
        raise e


class SandboxToolsBase(Tool):
    """Base class for all sandbox tools that provides project-based sandbox access."""
    
    # Class variable to track if sandbox URLs have been printed
    _urls_printed = False
    
    def __init__(self, project_id: str, thread_manager: Optional[ThreadManager] = None):
        super().__init__()
        self.project_id = project_id
        self.thread_manager = thread_manager
        self.workspace_path = "/workspace"
        self._sandbox = None
        self._sandbox_id = None
        self._sandbox_pass = None

    async def _ensure_sandbox(self) -> Sandbox:
        """Ensure we have a valid sandbox instance, retrieving it from the project if needed."""
        if self._sandbox is None:
            try:
                # Get database client
                client = await self.thread_manager.db.client
                
                # Get project data
                project = await client.table('projects').select('*').eq('project_id', self.project_id).execute()
                if not project.data or len(project.data) == 0:
                    raise ValueError(f"Project {self.project_id} not found")
                
                project_data = project.data[0]
                sandbox_info = project_data.get('sandbox', {})
                
                if not sandbox_info.get('id'):
                    raise ValueError(f"No sandbox found for project {self.project_id}")
                
                # Store sandbox info
                self._sandbox_id = sandbox_info['id']
                self._sandbox_pass = sandbox_info.get('pass')
                
                # Get or start the sandbox
                self._sandbox = await get_or_start_sandbox(self._sandbox_id)
                
                # # Log URLs if not already printed
                # if not SandboxToolsBase._urls_printed:
                #     vnc_link = self._sandbox.get_preview_link(6080)
                #     website_link = self._sandbox.get_preview_link(8080)
                    
                #     vnc_url = vnc_link.url if hasattr(vnc_link, 'url') else str(vnc_link)
                #     website_url = website_link.url if hasattr(website_link, 'url') else str(website_link)
                    
                #     print("\033[95m***")
                #     print(f"VNC URL: {vnc_url}")
                #     print(f"Website URL: {website_url}")
                #     print("***\033[0m")
                #     SandboxToolsBase._urls_printed = True
                
            except Exception as e:
                logger.error(f"Error retrieving sandbox for project {self.project_id}: {str(e)}", exc_info=True)
                raise e
        
        return self._sandbox

    @property
    def sandbox(self) -> Sandbox:
        """Get the sandbox instance, ensuring it exists."""
        if self._sandbox is None:
            raise RuntimeError("Sandbox not initialized. Call _ensure_sandbox() first.")
        return self._sandbox

    @property
    def sandbox_id(self) -> str:
        """Get the sandbox ID, ensuring it exists."""
        if self._sandbox_id is None:
            raise RuntimeError("Sandbox ID not initialized. Call _ensure_sandbox() first.")
        return self._sandbox_id

    def clean_path(self, path: str) -> str:
        """Clean and normalize a path to be relative to /workspace."""
        cleaned_path = clean_path(path, self.workspace_path)
        logger.debug(f"Cleaned path: {path} -> {cleaned_path}")
        return cleaned_path