import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import {
  StdioClientTransport,
  getDefaultEnvironment,
} from "@modelcontextprotocol/sdk/client/stdio.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { UnauthorizedError } from "@modelcontextprotocol/sdk/client/auth.js";
import ReconnectingEventSource from "reconnecting-eventsource";
import MCPHubOAuthProvider from "./utils/oauth-provider.js"
import {
  ListToolsResultSchema,
  ListResourcesResultSchema,
  ListResourceTemplatesResultSchema,
  CallToolResultSchema,
  ReadResourceResultSchema,
  LoggingMessageNotificationSchema,
  ToolListChangedNotificationSchema,
  ResourceListChangedNotificationSchema,
  PromptListChangedNotificationSchema,
  ListPromptsResultSchema,
} from "@modelcontextprotocol/sdk/types.js";
import EventEmitter from "events";
import logger from "./utils/logger.js";
import open from "open";
import {
  ConnectionError,
  ToolError,
  ResourceError,
  wrapError,
} from "./utils/errors.js";

const ConnectionStatus = {
  CONNECTED: "connected",
  CONNECTING: "connecting",
  DISCONNECTED: "disconnected",
  UNAUTHORIZED: "unauthorized", // New status for OAuth flow
  DISABLED: "disabled"
};


export class MCPConnection extends EventEmitter {
  constructor(name, config, marketplace, hubServerUrl) {
    super();
    this.name = name; // Keep as mcpId

    // OAuth state
    this.authProvider = null;
    this.authCallback = null;
    this.authCode = null;

    // Set display name from marketplace
    this.displayName = name; // Default to mcpId
    let serverDescription = ""
    if (marketplace?.cache?.catalog?.items) {
      const item = marketplace.cache.catalog.items.find(
        (item) => item.mcpId === name
      );
      if (item?.name) {
        this.displayName = item.name;
        serverDescription = item.description || ""
        logger.debug(`Using marketplace name for server '${name}'`, {
          name,
          displayName: item.name,
        });
      }
    }

    this.config = config;
    this.description = config.description ? config.description : serverDescription
    this.client = null;
    this.transport = null;
    this.transportType = config.type; // Store the transport type from config
    this.tools = [];
    this.resources = [];
    this.prompts = [];
    this.resourceTemplates = [];
    this.status = config.disabled ? ConnectionStatus.DISABLED : ConnectionStatus.DISCONNECTED;
    this.error = null;
    this.startTime = null;
    this.lastStarted = null;
    this.disabled = config.disabled || false;
    this.authorizationUrl = null;
    this.hubServerUrl = hubServerUrl
  }

  async start() {
    // If disabled, enable it
    if (this.disabled) {
      this.disabled = false;
      this.config.disabled = false;
      this.status = ConnectionStatus.DISCONNECTED;
    }

    // If already connected, return current state
    if (this.status === ConnectionStatus.CONNECTED) {
      return this.getServerInfo();
    }

    await this.connect();
    return this.getServerInfo();
  }

  async stop(disable = false) {
    if (disable) {
      this.disabled = true;
      this.config.disabled = true;
    }

    // if (this.status !== "disconnected") {
    await this.disconnect();
    // }

    return this.getServerInfo();
  }

  // Calculate uptime in seconds
  getUptime() {
    if (!this.startTime || ![ConnectionStatus.CONNECTED, ConnectionStatus.DISABLED].includes(this.status)) {
      return 0;
    }
    return Math.floor((Date.now() - this.startTime) / 1000);
  }

  async connect() {
    try {
      if (this.disabled) {
        this.status = ConnectionStatus.DISABLED;
        this.startTime = Date.now(); // Track uptime even when disabled
        this.lastStarted = new Date().toISOString();
        return;
      }

      this.error = null;
      this.status = ConnectionStatus.CONNECTING;
      this.lastStarted = new Date().toISOString();

      this.client = new Client(
        {
          name: "mcp-hub",
          version: "1.0.0",
        },
        {
          capabilities: {},
        }
      );
      // this.client.onerror = (error) => {
      //   //this might trigger mostly with sse transport due to any interuptions
      //   // logger.error("CLIENT_ERROR", `${this.name}: client error: ${error.message}`, {}, false);
      //   logger.debug(`${this.name}: client error: ${error.message}`)
      // };

      // Create appropriate transport based on transport type
      if (this.transportType === 'sse') {
        this.authProvider = this.createOAuthProvider()

        // SSE transport setup with reconnection support
        const reconnectingEventSourceOptions = {
          max_retry_time: 5000, // Maximum time between retries (5 seconds)
          // withCredentials: this.config.headers?.["Authorization"] ? true : false,
        };

        //HACK: sending reconnectingEventSourceOptions in the SSEClientTransport needs us to create custom fetch function with headers created from authProvider tokens. This way we can use ReconnectingEventSource with necessary options
        class ReconnectingES extends ReconnectingEventSource {
          constructor(url, options) {
            super(url, {
              ...options || {},
              ...reconnectingEventSourceOptions
            })
          }
        }
        // Use ReconnectingEventSource for automatic reconnection
        global.EventSource = ReconnectingES
        this.transport = new SSEClientTransport(new URL(this.config.url), {
          requestInit: {
            headers: this.config.headers || {},
          },
          authProvider: this.authProvider,
          // INFO:: giving eventSourceInit leading to infinite loop 
          // eventSourceInit: reconnectingEventSourceOptions
        });

        // Log reconnection attempts
        if (this.transport.eventSource) {
          this.transport.eventSource.onretry = (_) => {
            logger.info(`Attempting to reconnect to SSE server '${this.name}'`);
          };
        }
      } else {
        const env = this.config.env || {};
        // For each key in env, use process.env as fallback if value is falsy
        // This means empty string, null, undefined etc. will fall back to process.env value
        // Example: { API_KEY: "" } or { API_KEY: null } will use process.env.API_KEY
        Object.keys(env).forEach((key) => {
          env[key] = env[key] ? env[key] : process.env[key];
        });
        const serverEnv = {
          //INFO: getDefaultEnvironment is imp in order to start mcp servers properly
          ...getDefaultEnvironment(),
          ...(process.env.MCP_ENV_VARS
            ? JSON.parse(process.env.MCP_ENV_VARS)
            : {}),
          ...env,
        }

        // Default to STDIO transport
        this.transport = new StdioClientTransport({
          command: this.config.command,
          args: (this.config.args || []).map(arg => {
            //if arg starts with $ then replace it with the value from env
            if (arg.startsWith("$")) {
              const envKey = arg.substring(1);
              return serverEnv[envKey] || arg;
            }
            return arg;
          }),
          env: serverEnv,
          stderr: "pipe",
        });
      }

      // Handle transport errors with transport-specific details
      this.transport.onerror = (error) => {
        const connectionError = new ConnectionError(
          `${this.name}: transport error: ${error.message}`,
        );
        logger.error(
          connectionError.code,
          connectionError.message,
          connectionError.data,
          false
        );
        this.error = error.message;
        this.status = ConnectionStatus.DISCONNECTED;
        this.startTime = null;

        // Emit error event for handling at higher levels
        this.emit("connectionError", connectionError);
      };

      this.transport.onclose = () => {
        logger.info(`${this.transportType.toUpperCase()} transport connection closed for server '${this.name}'`);
        this.status = ConnectionStatus.DISCONNECTED;
        this.startTime = null;

        // Emit close event for handling reconnection if needed
        this.emit("connectionClosed", {
          server: this.name,
          type: this.transportType
        });
      };

      // Set up stderr handling before connecting (STDIO only)
      if (this.transportType !== 'sse') {
        const stderrStream = this.transport.stderr;
        if (stderrStream) {
          stderrStream.on("data", (data) => {
            const errorOutput = data.toString();
            const error = new ConnectionError("Server error output", {
              server: this.name,
              error: errorOutput,
            });
            logger.error(error.code, error.message, error.data, false);
            this.error = errorOutput;
          });
        }
      }

      try {
        // Connect client (this will start the transport)
        await this.client.connect(this.transport);
      } catch (error) {
        // Handle 401 unauthorized responses
        if (error.code === 401 || error instanceof UnauthorizedError) {
          logger.warn(`Server '${this.name}' requires authorization`);
          this.status = ConnectionStatus.UNAUTHORIZED;
          this.authorizationUrl = this.authProvider.generatedAuthUrl;
          return
        }
        throw error;
      }

      // Fetch initial capabilities before marking as connected
      await this.updateCapabilities();

      // Set up notification handlers
      this.setupNotificationHandlers();

      // Only mark as connected after capabilities are fetched
      this.status = ConnectionStatus.CONNECTED;
      this.startTime = Date.now();
      this.error = null;

      logger.info(`'${this.name}' MCP server connected`);
    } catch (error) {
      // Ensure proper cleanup on error
      await this.disconnect(error.message);

      throw new ConnectionError(
        `Failed to connect to "${this.name}" MCP server: ${error.message}`,
        {
          server: this.name,
          error: error.message,
        }
      );
    }
  }

  removeNotificationHandlers() {
    this.client.removeNotificationHandler(ToolListChangedNotificationSchema)
    this.client.removeNotificationHandler(ResourceListChangedNotificationSchema)
    this.client.removeNotificationHandler(PromptListChangedNotificationSchema)
    this.client.removeNotificationHandler(LoggingMessageNotificationSchema)
  }
  setupNotificationHandlers() {
    // Handle tool list changes
    this.client.setNotificationHandler(
      ToolListChangedNotificationSchema,
      async () => {
        logger.debug(
          `Received tools list changed notification from ${this.name}`
        );
        await this.updateCapabilities();
        this.emit("toolsChanged", {
          server: this.name,
          tools: this.tools,
        });
      }
    );

    // Handle resource list changes
    this.client.setNotificationHandler(
      ResourceListChangedNotificationSchema,
      async () => {
        logger.debug(
          `Received resources list changed notification from ${this.name}`
        );
        await this.updateCapabilities();
        this.emit("resourcesChanged", {
          server: this.name,
          resources: this.resources,
          resourceTemplates: this.resourceTemplates,
        });
      }
    );
    this.client.setNotificationHandler(
      PromptListChangedNotificationSchema,
      async () => {
        logger.debug(
          `Received prompts list changed notification from ${this.name}`
        );
        await this.updateCapabilities();
        this.emit("promptsChanged", {
          server: this.name,
          prompts: this.prompts,
        });
      })

    // Handle general logging messages
    this.client.setNotificationHandler(
      LoggingMessageNotificationSchema,
      (notification) => {
        let params = notification.params || {}
        let data = params.data || {}
        let level = params.level || "debug"
        logger.debug(`["${this.name}" server ${level} log]: ${JSON.stringify(data, null, 2)}`);
      }
    );
  }


  async updateCapabilities() {
    //skip for disabled servers
    if (!this.client) {
      return;
    }
    // Helper function to safely request capabilities
    const safeRequest = async (method, schema) => {
      try {
        const response = await this.client.request({ method }, schema);
        return response;
      } catch (error) {
        // logger.debug( `Server '${this.name}' does not support capability '${method}'`);
        return null;
      }
    };

    try {
      // Fetch all capabilities before updating state
      const [templatesResponse, toolsResponse, resourcesResponse, promptsResponse] =
        await Promise.all([
          safeRequest(
            "resources/templates/list",
            ListResourceTemplatesResultSchema
          ),
          safeRequest("tools/list", ListToolsResultSchema),
          safeRequest("resources/list", ListResourcesResultSchema),
          safeRequest("prompts/list", ListPromptsResultSchema),
        ]);

      // Update local state atomically, defaulting to empty arrays if capability not supported
      //TODO: handle pagination
      this.resourceTemplates = templatesResponse?.resourceTemplates || [];
      this.tools = toolsResponse?.tools || [];
      this.resources = resourcesResponse?.resources || [];
      this.prompts = promptsResponse?.prompts || [];
    } catch (error) {
      // Only log as warning since missing capabilities are expected in some cases
      logger.warn(`Error updating capabilities for server '${this.name}'`, {
        server: this.name,
        error: error.message,
      });

      // Reset capabilities to empty arrays
      this.resourceTemplates = [];
      this.tools = [];
      this.resources = [];
      this.prompts = [];
    }
  }


  async getPrompt(promptName, args) {
    if (!this.client) {
      throw new ToolError("Server not initialized", {
        server: this.name,
        prompt: promptName,
      });
    }
    if (this.status !== ConnectionStatus.CONNECTED) {
      throw new ToolError("Server not connected", {
        server: this.name,
        prompt: promptName,
        status: this.status,
      });
    }

    const prompt = this.prompts.find((p) => p.name === promptName);
    if (!prompt) {
      throw new ToolError("Prompt not found", {
        server: this.name,
        prompt: promptName,
        availablePrompts: this.prompts.map((p) => p.name),
      });
    }
    //check args, it should be either a list or an object or null
    if (args && !Array.isArray(args) && typeof args !== "object") {
      throw new ToolError("Invalid arguments", {
        server: this.name,
        prompt: promptName,
        args,
      });
    }

    try {
      return await this.client.getPrompt({
        name: promptName,
        arguments: args,
      })
    } catch (error) {
      throw wrapError(error, "PROMPT_EXECUTION_ERROR", {
        server: this.name,
        prompt: promptName,
        args,
      });
    }

  }

  /*
  * | Scenario            | Example Response                                                                 |
    |---------------------|----------------------------------------------------------------------------------|
    | Text Output         | `{ "content": [{ "type": "text", "text": "Hello, World!" }], "isError": false }` |
    | Image Output        | `{ "content": [{ "type": "image", "data": "base64data...", "mimeType": "image/png" }], "isError": false }` |
    | Text Resource       | `{ "content": [{ "type": "resource", "resource": { "uri": "file.txt", "text": "Content" } }], "isError": false }` |
    | Binary Resource     | `{ "content": [{ "type": "resource", "resource": { "uri": "image.jpg", "blob": "base64data...", "mimeType": "image/jpeg" } }], "isError": false }` |
    | Error Case          | `{ "content": [], "isError": true }` (Note: Error details might be in JSON-RPC level) |
    */
  async callTool(toolName, args) {
    if (!this.client) {
      throw new ToolError("Server not initialized", {
        server: this.name,
        tool: toolName,
      });
    }

    if (this.status !== ConnectionStatus.CONNECTED) {
      throw new ToolError("Server not connected", {
        server: this.name,
        tool: toolName,
        status: this.status,
      });
    }

    const tool = this.tools.find((t) => t.name === toolName);
    if (!tool) {
      throw new ToolError("Tool not found", {
        server: this.name,
        tool: toolName,
        availableTools: this.tools.map((t) => t.name),
      });
    }

    //check args, it should be either a list or an object or null
    if (args && !Array.isArray(args) && typeof args !== "object") {
      throw new ToolError("Invalid arguments", {
        server: this.name,
        tool: toolName,
        args,
      });
    }

    try {
      return await this.client.request(
        {
          method: "tools/call",
          params: {
            name: toolName,
            arguments: args,
          },
        },
        CallToolResultSchema
      );
    } catch (error) {
      throw wrapError(error, "TOOL_EXECUTION_ERROR", {
        server: this.name,
        tool: toolName,
        args,
      });
    }
  }

  /*
  * | Scenario                     | Example Response                                                                 |
    |------------------------------|----------------------------------------------------------------------------------|
    | Text Resource                | `{ "contents": [{ "uri": "file.txt", "text": "This is the content of the file." }] }` |
    | Binary Resource without `mimeType` | `{ "contents": [{ "uri": "image.jpg", "blob": "base64encodeddata..." }] }`         |
    | Binary Resource with `mimeType` | `{ "contents": [{ "uri": "image.jpg", "mimeType": "image/jpeg", "blob": "base64encodeddata..." }] }` |
    | Multiple Resources           | `{ "contents": [{ "uri": "file1.txt", "text": "Content of file1" }, { "uri": "file2.png", "blob": "base64encodeddata..." }] }` |
    | No Resources (empty)         | `{ "contents": [] }`                                                             |
  */

  async readResource(uri) {
    if (!this.client) {
      throw new ResourceError("Server not initialized", {
        server: this.name,
        uri,
      });
    }

    if (this.status !== ConnectionStatus.CONNECTED) {
      throw new ResourceError("Server not connected", {
        server: this.name,
        uri,
        status: this.status,
      });
    }

    const isValidResource =
      this.resources.some((r) => r.uri === uri) ||
      this.resourceTemplates.some((t) => {
        // Convert template to regex pattern
        const pattern = t.uriTemplate.replace(/\{[^}]+\}/g, "[^/]+");
        return new RegExp(`^${pattern}$`).test(uri);
      });

    if (!isValidResource) {
      throw new ResourceError(`Resource not found : ${uri}`, {
        server: this.name,
        uri,
        availableResources: this.resources.map((r) => r.uri),
        availableTemplates: this.resourceTemplates.map((t) => t.uriTemplate),
      });
    }

    try {
      return await this.client.request(
        {
          method: "resources/read",
          params: { uri },
        },
        ReadResourceResultSchema
      );
    } catch (error) {
      throw wrapError(error, "RESOURCE_READ_ERROR", {
        server: this.name,
        uri,
      });
    }
  }



  async resetState(error) {
    this.client = null;
    this.transport = null;
    this.tools = [];
    this.resources = [];
    this.prompts = [];
    this.resourceTemplates = [];
    this.status = this.config.disabled ? ConnectionStatus.DISABLED : ConnectionStatus.DISCONNECTED;
    this.error = error || null;
    this.startTime = null;
    this.lastStarted = null;
    this.disabled = this.config.disabled || false;
  }

  async disconnect(error) {
    if (this.client) {
      this.removeNotificationHandlers();
      await this.client.close();
    }
    if (this.transport) {
      await this.transport.close();
    }

    this.resetState(error);
  }

  // Create OAuth provider with proper metadata and storage
  createOAuthProvider() {
    return new MCPHubOAuthProvider({
      serverName: this.name,
      serverUrl: this.config.url,
      hubServerUrl: this.hubServerUrl
    })
  }

  async authorize() {
    if (!this.authorizationUrl) {
      throw new Error(`No authorization URL available for server '${this.name}'`);
    }
    //validate
    new URL(this.authorizationUrl)
    // log it in cases where the user in a browserless environment
    logger.info(`Opening authorization URL for server '${this.name}': ${this.authorizationUrl.toString()}`);
    // Open the authorization URL in the default browser 
    await open(this.authorizationUrl.toString())
    //Once the user authorizes, handleAuthCallback is called.
    return {
      authorizationUrl: this.authorizationUrl,
    }
  }


  async handleAuthCallback(code) {
    logger.debug(`Handling OAuth callback for server '${this.name}'`);
    await this.transport.finishAuth(code);
    logger.debug(`Successful code exchange for '${this.name}': Authorized, connecting with new tokens`);
    await this.connect()
  }

  getServerInfo() {
    return {
      name: this.name, // Original mcpId
      displayName: this.displayName, // Friendly name from marketplace
      description: this.description,
      transportType: this.transportType, // Include transport type in server info
      status: this.status,
      error: this.error,
      capabilities: {
        tools: this.tools,
        resources: this.resources,
        resourceTemplates: this.resourceTemplates,
        prompts: this.prompts,
      },
      uptime: this.getUptime(),
      lastStarted: this.lastStarted,
      authorizationUrl: this.authorizationUrl,
    };
  }
}
