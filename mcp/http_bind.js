export function bindHttp(server, { host, port, label }) {
  server.on('error', error => {
    if (error?.code === 'EADDRINUSE') {
      console.error(`DOOM MCP: ${host}:${port} already in use; reusing existing ${label}`);
      return;
    }
    console.error(`DOOM MCP: ${label} listen failed: ${error?.stack || error?.message || error}`);
  });
  server.listen({ port, host, exclusive: true }, () => {
    console.error(`DOOM MCP: ${label}`);
  });
  return server;
}
