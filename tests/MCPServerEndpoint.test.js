import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { MCPServerEndpoint } from '../src/mcp/server.js';
import logger from '../src/utils/logger.js';

const createMockHub = () => ({
  on: vi.fn(),
  connections: new Map(),
  rawRequest: vi.fn(),
});

describe('MCPServerEndpoint transport wrapping', () => {
  let originalDebug;

  beforeEach(() => {
    originalDebug = logger.debug;
    logger.debug = vi.fn();
  });

  afterEach(() => {
    logger.debug = originalDebug;
    vi.restoreAllMocks();
  });

  it('swallows disconnect errors and runs cleanup once', async () => {
    const endpoint = new MCPServerEndpoint(createMockHub());
    const cleanupSpy = vi.fn();
    let cleanupRan = false;
    const cleanup = async () => {
      if (cleanupRan) {
        return;
      }
      cleanupRan = true;
      cleanupSpy();
    };
    const transport = {
      sessionId: 'session-1',
      send: vi.fn().mockRejectedValue(new Error('Not connected')),
    };

    endpoint.wrapTransportSend(transport, cleanup);

    await expect(transport.send({})).resolves.toBeUndefined();
    expect(cleanupSpy).toHaveBeenCalledTimes(1);
    // Subsequent calls continue to be swallowed without additional cleanup
    await expect(transport.send({})).resolves.toBeUndefined();
    expect(cleanupSpy).toHaveBeenCalledTimes(1);
  });

  it('rethrows non-disconnect errors', async () => {
    const endpoint = new MCPServerEndpoint(createMockHub());
    const transport = {
      sessionId: 'session-2',
      send: vi.fn().mockRejectedValue(new Error('Unexpected failure')),
    };

    endpoint.wrapTransportSend(transport, vi.fn());

    await expect(transport.send({})).rejects.toThrow('Unexpected failure');
  });
});
