/**
 * MCP Hub Server Endpoint - Unified MCP Server Interface
 * 
 * This module creates a single MCP server endpoint that exposes ALL capabilities
 * from multiple managed MCP servers through one unified interface.
 * 
 * HOW IT WORKS:
 * 1. MCP Hub manages multiple individual MCP servers (like filesystem, github, etc.)
 * 2. This endpoint collects all tools/resources/prompts from those servers
 * 3. It creates a single MCP server that any MCP client can connect to
 * 4. When a client calls a tool, it routes the request to the correct underlying server
 * 
 * BENEFITS:
 * - Users manage all MCP servers in one place through MCP Hub's TUI
 * - MCP clients (like Claude Desktop, Cline, etc.) only need to connect to one endpoint
 * - No need to configure each MCP client with dozens of individual server connections
 * - Automatic capability updates when servers are added/removed/restarted
 * 
 * EXAMPLE:
 * Just configure clients with with:
 * {
 *  "Hub": {
 *    "url": "http://localhost:${port}/mcp"
 *  }
 * }
 * The hub automatically namespaces capabilities to avoid conflicts:
 * - "search" tool from filesystem server becomes "filesystem__search"
 * - "search" tool from github server becomes "github__search"
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { randomUUID } from "crypto";
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
  GetPromptResultSchema,
  CallToolResultSchema,
  ReadResourceResultSchema,
  ListResourcesRequestSchema,
  ReadResourceRequestSchema,
  ListResourceTemplatesRequestSchema,
  ListPromptsRequestSchema,
  GetPromptRequestSchema,
  McpError,
  ErrorCode,
} from "@modelcontextprotocol/sdk/types.js";
import { HubState } from "../utils/sse-manager.js";
import logger from "../utils/logger.js";

// Unique server name to identify our internal MCP endpoint
const HUB_INTERNAL_SERVER_NAME = "mcp-hub-internal-endpoint";

// Delimiter for namespacing
const DELIMITER = '__';
const MCP_REQUEST_TIMEOUT = 5 * 60 * 1000 //Default to 5 minutes
const RECENTLY_CLOSED_SESSION_TTL_MS = 30_000;
const TRANSPORT_SEND_WRAPPED = Symbol('TRANSPORT_SEND_WRAPPED');
const DISCONNECT_ERROR_PATTERNS = [
  'Not connected',
  'write after end',
  'ERR_STREAM_WRITE_AFTER_END',
  'No connection established'
];

const normalizeMode = (value, allowed, fallback) => {
  if (!value) {
    return fallback;
  }
  const normalized = String(value).toLowerCase().trim();
  return allowed.includes(normalized) ? normalized : fallback;
};

const STREAMABLE_HTTP_GET_MODE = normalizeMode(
  process.env.MCP_HUB_STREAMABLE_HTTP_GET_MODE,
  ['auto', 'enabled', 'disabled'],
  'auto'
);

const STREAMABLE_HTTP_RESPONSE_MODE = normalizeMode(
  process.env.MCP_HUB_STREAMABLE_HTTP_RESPONSE_MODE,
  ['auto', 'sse', 'json'],
  'auto'
);

// Comprehensive capability configuration
const CAPABILITY_TYPES = {
  TOOLS: {
    id: 'tools',
    uidField: 'name',
    syncWithEvents: {
      events: ['toolsChanged'],
      capabilityIds: ['tools'],
      notificationMethod: 'sendToolListChanged'
    },
    listSchema: ListToolsRequestSchema,
    handler: {
      method: "tools/call",
      callSchema: CallToolRequestSchema,
      resultSchema: CallToolResultSchema,
      form_error(error) {
        return {
          content: [
            {
              type: "text",
              text: error instanceof Error ? error.message : String(error),
            },
          ],
          isError: true,
        }
      },
      form_params(cap, request) {
        return {
          name: cap.originalName,
          arguments: request.params.arguments || {},
        }
      }
    }
  },
  RESOURCES: {
    id: 'resources',
    uidField: 'uri',
    syncWithEvents: {
      events: ['resourcesChanged'],
      capabilityIds: ['resources', 'resourceTemplates'],
      notificationMethod: 'sendResourceListChanged'
    },
    listSchema: ListResourcesRequestSchema,
    handler: {
      method: "resources/read",
      form_error(error) {
        throw new McpError(ErrorCode.InvalidParams, `Failed to read resource: ${error.message}`);
      },
      form_params(cap, request) {
        return {
          uri: cap.originalName,
        }
      },
      callSchema: ReadResourceRequestSchema,
      resultSchema: ReadResourceResultSchema,
    }
  },
  RESOURCE_TEMPLATES: {
    id: 'resourceTemplates',
    uidField: 'uriTemplate',
    // No syncWithEvents - handled by resources event
    listSchema: ListResourceTemplatesRequestSchema,
    // No callSchema - templates are listed only
    syncWithEvents: {
      events: [],
      capabilityIds: [],
      notificationMethod: 'sendResourceListChanged'
    },
  },
  PROMPTS: {
    id: 'prompts',
    uidField: 'name',
    syncWithEvents: {
      events: ['promptsChanged'],
      capabilityIds: ['prompts'],
      notificationMethod: 'sendPromptListChanged'
    },
    listSchema: ListPromptsRequestSchema,
    handler: {
      method: "prompts/get",
      callSchema: GetPromptRequestSchema,
      resultSchema: GetPromptResultSchema,
      form_params(cap, request) {
        return {
          name: cap.originalName,
          arguments: request.params.arguments || {},
        }
      },
      form_error(error) {
        throw new McpError(ErrorCode.InvalidParams, `Failed to read resource: ${error.message}`);
      }
    }
  },
};

/**
 * MCP Server endpoint that exposes all managed server capabilities
 * This allows standard MCP clients to connect to mcp-hub via MCP protocol
 */
export class MCPServerEndpoint {
  constructor(mcpHub) {
    this.mcpHub = mcpHub;
    this.clients = new Map(); // sessionId -> { transport, server }
    this.serversMap = new Map(); // sessionId -> server instance
    this.recentlyClosedSessions = new Map(); // sessionId -> timeout

    // Store registered capabilities by type
    this.registeredCapabilities = {};
    Object.values(CAPABILITY_TYPES).forEach(capType => {
      this.registeredCapabilities[capType.id] = new Map(); // namespacedName -> { serverName, originalName, definition }
    });

    // Setup capability synchronization once
    this.setupCapabilitySync();

    // Initial capability registration
    this.syncCapabilities();
  }

  isLikelyCloudflareRequest(req) {
    if (!req?.headers) {
      return false;
    }
    const headers = req.headers;
    return Boolean(
      headers['cf-connecting-ip'] ||
      headers['cf-visitor'] ||
      headers['cf-ray'] ||
      headers['cf-ew-via'] ||
      headers['cf-worker'] ||
      headers['cf-ipcountry']
    );
  }

  shouldDisableStandaloneStream(req) {
    if (STREAMABLE_HTTP_GET_MODE === 'disabled') {
      return true;
    }
    if (STREAMABLE_HTTP_GET_MODE === 'enabled') {
      return false;
    }
    return this.isLikelyCloudflareRequest(req);
  }

  shouldForceJsonResponse(req) {
    if (STREAMABLE_HTTP_RESPONSE_MODE === 'json') {
      return true;
    }
    if (STREAMABLE_HTTP_RESPONSE_MODE === 'sse') {
      return false;
    }
    if (STREAMABLE_HTTP_RESPONSE_MODE === 'auto') {
      if (this.shouldDisableStandaloneStream(req)) {
        return true;
      }
    }
    return false;
  }

  getEndpointUrl() {
    return `${this.mcpHub.hubServerUrl}/mcp`;
  }

  buildInstructions() {
    this.syncServersMap();

    const lines = [
      "MCP Hub aggregates multiple MCP servers behind a single MCP endpoint.",
      "Tools, resources, prompts, and templates are namespaced as <serverId>__<name>. Use the full identifier when invoking a capability.",
    ];

    const activeServers = Array.from(this.serversMap.entries()).filter(([, connection]) =>
      connection.status === "connected" && !connection.disabled
    );

    if (activeServers.length === 0) {
      lines.push("No MCP servers are currently connected. Connect servers to expose their tools through the hub.");
    } else {
      lines.push("Connected servers (identifier -> display name and capability counts):");
      activeServers.forEach(([serverId, connection]) => {
        const displayName = connection.displayName || connection.name;
        const toolCount = Array.isArray(connection.tools) ? connection.tools.length : 0;
        const resourceCount = Array.isArray(connection.resources) ? connection.resources.length : 0;
        const promptCount = Array.isArray(connection.prompts) ? connection.prompts.length : 0;
        const templateCount = Array.isArray(connection.resourceTemplates) ? connection.resourceTemplates.length : 0;

        const capabilitySummary = [`${toolCount} tools`, `${resourceCount} resources`];
        if (templateCount > 0) {
          capabilitySummary.push(`${templateCount} resource templates`);
        }
        capabilitySummary.push(`${promptCount} prompts`);

        lines.push(`- ${serverId} -> ${displayName} (${capabilitySummary.join(", ")})`);
      });
      lines.push("Call tools using the namespaced identifier, for example `context7__search`, and run `tools/list` to review the live catalog.");
    }

    return lines.join("\n");
  }

  /**
   * Create a new MCP server instance for each connection
   */
  createServer() {
    // Create low-level MCP server instance with unique name
    const server = new Server(
      {
        name: HUB_INTERNAL_SERVER_NAME,
        version: "1.0.0",
      },
      {
        capabilities: {
          tools: {
            listChanged: true
          },
          resources: {
            listChanged: true,
          },
          prompts: {
            listChanged: true,
          },
        },
        instructions: this.buildInstructions(),
      }
    );
    server.onerror = function(err) {
      logger.warn(`Hub Endpoint onerror: ${err.message}`);
    }
    // Setup request handlers for this server instance
    this.setupRequestHandlers(server);

    return server;
  }

  isDisconnectError(error) {
    if (!error) {
      return false;
    }
    const message = typeof error.message === 'string' ? error.message : String(error);
    if (!message) {
      return false;
    }
    if (error.code === 'ERR_STREAM_WRITE_AFTER_END') {
      return true;
    }
    return DISCONNECT_ERROR_PATTERNS.some(pattern => message.includes(pattern));
  }

  wrapTransportSend(transport, cleanup) {
    if (!transport || typeof transport.send !== 'function') {
      return;
    }
    if (transport[TRANSPORT_SEND_WRAPPED]) {
      return;
    }
    const originalSend = transport.send.bind(transport);
    transport.send = async (...args) => {
      try {
        return await originalSend(...args);
      } catch (error) {
        if (this.isDisconnectError(error)) {
          const sessionId = transport.sessionId;
          if (typeof logger.debug === 'function') {
            logger.debug(`Ignoring transport send after disconnect for session '${sessionId ?? 'unknown'}': ${error.message}`);
          }
          if (typeof cleanup === 'function') {
            try {
              await cleanup();
            } catch (cleanupError) {
              if (typeof logger.debug === 'function') {
                logger.debug(`Cleanup error after disconnect for session '${sessionId ?? 'unknown'}': ${cleanupError.message}`);
              }
            }
          }
          return;
        }
        throw error;
      }
    };
    transport[TRANSPORT_SEND_WRAPPED] = true;
  }

  /**
   * Creates a safe server name for namespacing (replace special chars with underscores)
   */
  createSafeServerName(serverName) {
    return serverName.replace(/[^a-zA-Z0-9]/g, '_');
  }


  /**
   * Setup MCP request handlers for a server instance
   */
  setupRequestHandlers(server) {
    // Setup handlers for each capability type
    Object.values(CAPABILITY_TYPES).forEach(capType => {
      const capId = capType.id;

      // Setup list handler if schema exists
      if (capType.listSchema) {
        server.setRequestHandler(capType.listSchema, () => {
          const capabilityMap = this.registeredCapabilities[capId];
          const capabilities = Array.from(capabilityMap.values()).map(item => item.definition);
          return { [capId]: capabilities };
        });
      }

      // Setup call/action handler if schema exists
      if (capType.handler?.callSchema) {
        server.setRequestHandler(capType.handler.callSchema, async (request, extra) => {

          const registeredCap = this.getRegisteredCapability(request, capType.id, capType.uidField);
          if (!registeredCap) {
            throw new McpError(
              ErrorCode.InvalidParams,
              `${capId} capability not found: ${key}`
            );
          }
          const { serverName, originalName } = registeredCap;
          const request_options = {
            timeout: MCP_REQUEST_TIMEOUT
          }
          try {
            const result = await this.mcpHub.rawRequest(serverName, {
              method: capType.handler.method,
              params: capType.handler.form_params(registeredCap, request)
            }, capType.handler.resultSchema, request_options)
            return result;
          } catch (error) {
            logger.debug(`Error executing ${capId} '${originalName}': ${error.message}`);
            return capType.handler.form_error(error)
          }
        });
      }
    });
  }

  getRegisteredCapability(request, capId, uidField) {
    const capabilityMap = this.registeredCapabilities[capId];
    let key = request.params[uidField]
    const registeredCap = capabilityMap.get(key);
    // key might be a resource Template
    if (!registeredCap && capId === CAPABILITY_TYPES.RESOURCES.id) {
      let [serverName, ...uri] = key.split(DELIMITER);
      if (!serverName || !uri) {
        return null; // Invalid format
      }
      serverName = this.serversMap.get(serverName)?.name
      return {
        serverName,
        originalName: uri.join(DELIMITER),
      }
    }
    return registeredCap
  }

  /**
   * Setup listeners for capability changes from managed servers
   */
  setupCapabilitySync() {
    // For each capability type with syncWithEvents
    Object.values(CAPABILITY_TYPES).forEach(capType => {
      if (capType.syncWithEvents) {
        const { events, capabilityIds } = capType.syncWithEvents;

        events.forEach(event => {
          this.mcpHub.on(event, (data) => {
            this.syncCapabilities(capabilityIds);
          });
        });
      }
    });

    // Global events that sync ALL capabilities
    const globalSyncEvents = ['importantConfigChangeHandled'];
    globalSyncEvents.forEach(event => {
      this.mcpHub.on(event, (data) => {
        this.syncCapabilities(); // Sync all capabilities
      });
    });

    // Listen for hub state changes to re-sync all capabilities when servers are ready
    this.mcpHub.on('hubStateChanged', (data) => {
      const { state } = data;
      const criticalStates = [HubState.READY, HubState.RESTARTED, HubState.STOPPED, HubState.ERROR];

      if (criticalStates.includes(state)) {
        this.syncCapabilities(); // Sync all capabilities
      }
    });
  }

  /**
   * Synchronize capabilities from connected servers
   * @param {string[]} capabilityIds - Specific capability IDs to sync, defaults to all
   */
  syncCapabilities(capabilityIds = null) {
    // Default to all capability IDs if none specified
    const idsToSync = capabilityIds || Object.values(CAPABILITY_TYPES).map(capType => capType.id);

    // Update the servers map with current connection states
    this.syncServersMap()

    // Sync each requested capability type and notify clients of changes
    idsToSync.forEach(capabilityId => {
      const changed = this.syncCapabilityType(capabilityId);
      if (changed) {
        // Send notification for this specific capability type if we have active connections
        if (this.hasActiveConnections()) {
          const capType = Object.values(CAPABILITY_TYPES).find(cap => cap.id === capabilityId);
          if (capType?.syncWithEvents?.notificationMethod) {
            this.notifyCapabilityChanges(capType.syncWithEvents.notificationMethod);
          }
        }
      }
    });
  }

  /**
   * Synchronize the servers map with current connection states
   * Creates safe server IDs for namespacing capabilities
   */
  syncServersMap() {
    this.serversMap.clear();

    // Register all connected servers with unique safe IDs
    for (const connection of this.mcpHub.connections.values()) {
      if (connection.status === "connected" && !connection.disabled) {
        const name = connection.name;
        let id = this.createSafeServerName(name);

        // Ensure unique ID by appending counter if needed
        if (this.serversMap.has(id)) {
          let counter = 1;
          while (this.serversMap.has(`${id}_${counter}`)) {
            counter++;
          }
          id = `${id}_${counter}`;
        }
        this.serversMap.set(id, connection);
      }
    }
  }

  /**
   * Synchronize a specific capability type and detect changes
   */
  syncCapabilityType(capabilityId) {
    const capabilityMap = this.registeredCapabilities[capabilityId];
    const previousKeys = new Set(capabilityMap.keys());

    // Clear and rebuild capabilities from connected servers
    capabilityMap.clear();
    for (const [serverId, connection] of this.serversMap) {
      if (connection.status === "connected" && !connection.disabled) {
        this.registerServerCapabilities(connection, { capabilityId, serverId });
      }
    }

    // Check if capability keys changed
    const newKeys = new Set(capabilityMap.keys());
    return previousKeys.size !== newKeys.size ||
      [...newKeys].some(key => !previousKeys.has(key));
  }


  /**
   * Send capability change notifications to all connected clients
   */
  notifyCapabilityChanges(notificationMethod) {
    for (const { server } of this.clients.values()) {
      try {
        server[notificationMethod]();
      } catch (error) {
        logger.warn(`Error sending ${notificationMethod} notification: ${error.message}`);
      }
    }
  }

  /**
   * Register capabilities from a server connection for a specific capability type
   * Creates namespaced capability names to avoid conflicts between servers
   */
  registerServerCapabilities(connection, { capabilityId, serverId }) {
    const serverName = connection.name;

    // Skip self-reference to prevent infinite recursion
    if (this.isSelfReference(connection)) {
      return;
    }

    // Find the capability type configuration and get server's capabilities
    const capType = Object.values(CAPABILITY_TYPES).find(cap => cap.id === capabilityId);
    const capabilities = connection[capabilityId];
    if (!capabilities || !Array.isArray(capabilities)) {
      return; // No capabilities of this type
    }

    const capabilityMap = this.registeredCapabilities[capabilityId];

    // Register each capability with namespaced name
    for (const cap of capabilities) {
      const originalValue = cap[capType.uidField];
      const uniqueName = serverId + DELIMITER + originalValue;

      // Create capability with namespaced unique identifier
      const formattedCap = {
        ...cap,
        [capType.uidField]: uniqueName
      };

      // Store capability with metadata for routing back to original server
      capabilityMap.set(uniqueName, {
        serverName,
        originalName: originalValue,
        definition: formattedCap,
      });
    }
  }


  /**
   * Check if a connection is a self-reference (connecting to our own MCP endpoint)
   */
  isSelfReference(connection) {
    // Primary check: Compare server's reported name with our internal server name
    if (connection.serverInfo && connection.serverInfo.name === HUB_INTERNAL_SERVER_NAME) {
      return true;
    }
    return false;
  }

  /**
   * Check if there are any active MCP client connections
   */
  hasActiveConnections() {
    return this.clients.size > 0;
  }

  normalizeSessionId(raw) {
    if (Array.isArray(raw)) {
      return raw[0];
    }
    return raw ?? undefined;
  }

  clearRecentlyClosedSession(sessionId) {
    if (!sessionId) {
      return;
    }
    const timer = this.recentlyClosedSessions.get(sessionId);
    if (timer) {
      clearTimeout(timer);
      this.recentlyClosedSessions.delete(sessionId);
    }
  }

  markSessionClosed(sessionId) {
    if (!sessionId) {
      return;
    }
    this.clearRecentlyClosedSession(sessionId);
    const timeout = setTimeout(() => {
      this.recentlyClosedSessions.delete(sessionId);
    }, RECENTLY_CLOSED_SESSION_TTL_MS);
    if (typeof timeout.unref === 'function') {
      timeout.unref();
    }
    this.recentlyClosedSessions.set(sessionId, timeout);
  }

  isRecentlyClosedSession(sessionId) {
    if (!sessionId) {
      return false;
    }
    return this.recentlyClosedSessions.has(sessionId);
  }




  /**
   * Handle SSE transport creation (GET /mcp)
   */
  async handleSSEConnection(req, res) {

    // Create SSE transport
    const transport = new SSEServerTransport('/messages', res);
    const sessionId = transport.sessionId;
    this.clearRecentlyClosedSession(sessionId);

    // Create a new server instance for this connection
    const server = this.createServer();

    let clientInfo


    let cleanupCalled = false;
    // Setup cleanup on close (ensure it only runs once)
    const cleanup = async () => {
      if (cleanupCalled) return;
      cleanupCalled = true;
      this.clients.delete(sessionId);
      this.markSessionClosed(sessionId);
      try {
        await server.close();
      } catch (error) {
        logger.warn(`Error closing server connected to ${clientInfo?.name ?? "Unknown"}: ${error.message}`);
      } finally {
        logger.info(`'${clientInfo?.name ?? "Unknown"}' client disconnected from MCP HUB`);
      }
    };

    // Store transport and server together
    this.clients.set(sessionId, { transport, server });

    this.wrapTransportSend(transport, cleanup);

    res.on("close", cleanup);
    transport.onclose = cleanup;

    // Connect MCP server to transport
    await server.connect(transport);
    server.oninitialized = () => {
      clientInfo = server.getClientVersion()
      if (clientInfo) {
        logger.info(`'${clientInfo.name}' client connected to MCP HUB`)
      }
    }
  }

  /**
   * Handle MCP messages (POST /messages)
   * Legacy SSE transport endpoint
   */
  async handleMCPMessage(req, res) {
    const sessionId = this.normalizeSessionId(req.query.sessionId);
    function sendErrorResponse(code, error) {
      res.status(code).json({
        jsonrpc: "2.0",
        error: {
          code: -32000,
          message: error.message || 'Invalid request',
        },
        id: null,
      });
    }

    if (!sessionId) {
      logger.warn('MCP message received without session ID');
      return sendErrorResponse(400, new Error('Missing sessionId parameter'));
    }

    const transportInfo = this.clients.get(sessionId);
    if (transportInfo) {
      await transportInfo.transport.handlePostMessage(req, res, req.body);
    } else {
      if (this.isRecentlyClosedSession(sessionId)) {
        logger.debug(`MCP message received for recently closed session: ${sessionId}`);
        return sendErrorResponse(404, new Error(`Session closed: ${sessionId}`));
      }
      logger.warn(`MCP message for unknown session: ${sessionId}`);
      return sendErrorResponse(404, new Error(`Session not found: ${sessionId}`));
    }
  }

  /**
   * Handle Streamable HTTP transport requests (new MCP protocol)
   * Supports both POST and GET requests on a single endpoint
   */
  async handleStreamableHTTP(req, res) {
    try {
      // Check if this is for an existing session
      const sessionId = req.headers['mcp-session-id'];
      const normalizedSessionId = this.normalizeSessionId(sessionId);

      if (normalizedSessionId) {
        // Reuse existing transport for this session
        const clientInfo = this.clients.get(normalizedSessionId);
        if (clientInfo) {
          await clientInfo.transport.handleRequest(req, res, req.body);
          return;
        }

        // For recently closed sessions, allow reconnection by creating a new session
        // This prevents the hub from appearing "dead" after session timeouts
        if (this.isRecentlyClosedSession(normalizedSessionId)) {
          logger.debug(`Streamable HTTP reconnection attempt for recently closed session '${normalizedSessionId}' - creating new session`);
          // Fall through to create new session below
        } else {
          logger.debug(`Streamable HTTP request received for unknown session '${normalizedSessionId}' - creating new session`);
          // Fall through to create new session below
        }
      }

      // Create new transport and server for new session
      let transport;
      let server;

      // For reconnection attempts with existing session ID, force creation of new session
      const forceNewSession = !!normalizedSessionId && !this.clients.has(normalizedSessionId);

      const transportOptions = {
        // Generate cryptographically secure session IDs
        sessionIdGenerator: () => randomUUID(),

        // DNS rebinding protection - disabled by default for local development
        // Enable in production with appropriate allowedOrigins/allowedHosts configuration
        enableDnsRebindingProtection: false,
        onsessioninitialized: (newSessionId) => {
          if (!newSessionId) {
            return;
          }
          logger.debug(`Streamable HTTP session created: ${newSessionId}`);
          this.clearRecentlyClosedSession(newSessionId);
          this.clients.set(newSessionId, { transport, server });

          // Log reconnection attempts
          if (normalizedSessionId && normalizedSessionId !== newSessionId) {
            logger.info(`Reconnected client with new session ${newSessionId}`);
          }
        },
      };

      const enableJsonResponse = this.shouldForceJsonResponse(req);
      if (enableJsonResponse) {
        transportOptions.enableJsonResponse = true;
        const message = `Enabling Streamable HTTP JSON response mode for '${req.headers.host || 'unknown'}' session due to proxy compatibility`;
        if (typeof logger.debug === 'function') {
          logger.debug(message);
        } else if (typeof logger.info === 'function') {
          logger.info(message);
        }
      }

      // Create a new server instance for this session
      transport = new StreamableHTTPServerTransport(transportOptions);
      server = this.createServer();

      let clientInfo;

      // Setup cleanup for when transport closes
      const cleanup = async () => {
        if (transport.sessionId) {
          this.clients.delete(transport.sessionId);
          this.markSessionClosed(transport.sessionId);
        }
        try {
          await server.close();
        } catch (error) {
          logger.warn(`Error closing server: ${error.message}`);
        } finally {
          logger.info(`'${clientInfo?.name ?? "Unknown"}' client disconnected from MCP HUB (Streamable HTTP)`);
        }
      };

      this.wrapTransportSend(transport, cleanup);

      transport.onclose = cleanup;

      // Connect MCP server to transport BEFORE handling the request
      await server.connect(transport);

      server.oninitialized = () => {
        clientInfo = server.getClientVersion();
        if (clientInfo) {
          logger.info(`'${clientInfo.name}' client connected to MCP HUB (Streamable HTTP)`);
        }
      };

      // Handle the HTTP request
      await transport.handleRequest(req, res, req.body);

    } catch (error) {
      logger.warn(`Error handling Streamable HTTP request: ${error.message}`);
      if (!res.headersSent) {
        res.status(500).json({
          jsonrpc: "2.0",
          error: {
            code: -32603,
            message: "Internal error",
          },
          id: null,
        });
      }
    }
  }

  /**
   * Get statistics about the MCP endpoint
   */
  getStats() {
    const capabilityCounts = Object.entries(this.registeredCapabilities)
      .reduce((acc, [type, map]) => {
        acc[type] = map.size;
        return acc;
      }, {});

    return {
      activeClients: this.clients.size,
      registeredCapabilities: capabilityCounts,
      totalCapabilities: Object.values(capabilityCounts).reduce((sum, count) => sum + count, 0),
    };
  }

  /**
   * Close all transports and cleanup
   */
  async close() {
    // Close all servers (which will close their transports)
    for (const [sessionId, { server }] of this.clients) {
      try {
        await server.close();
      } catch (error) {
        logger.debug(`Error closing server ${sessionId}: ${error.message}`);
      }
    }

    this.clients.clear();
    for (const timeout of this.recentlyClosedSessions.values()) {
      clearTimeout(timeout);
    }
    this.recentlyClosedSessions.clear();

    // Clear all registered capabilities
    Object.values(this.registeredCapabilities).forEach(map => map.clear());

    logger.info('MCP server endpoint closed');
  }
}
