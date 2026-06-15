import http from 'http';
import app from './app.js';
import { connectDB } from './config/db.js';
import { env } from './config/env.js';
import { startOutboxDispatcher } from './services/eventDispatcher.js';
import { closePdfBrowser } from './services/pdfService.js';
import { initSocket } from './services/socketService.js';

const startServer = async () => {
  try {
    await connectDB();
    const server = http.createServer(app);
    initSocket(server);
    startOutboxDispatcher();

    server.listen(env.port, () => {
      console.log(`QuickInvoice API running on port ${env.port}`);
    });

    // Shut down the shared headless-Chromium instance with the process so it does
    // not linger after a restart. Guarded so a double signal can't run twice.
    let shuttingDown = false;
    const shutdown = async (signal) => {
      if (shuttingDown) return;
      shuttingDown = true;
      console.log(`Received ${signal}, shutting down...`);
      server.close();
      await closePdfBrowser();
      process.exit(0);
    };
    process.on('SIGTERM', () => shutdown('SIGTERM'));
    process.on('SIGINT', () => shutdown('SIGINT'));
  } catch (error) {
    console.error('Failed to start server:', error.message);
    process.exit(1);
  }
};

startServer();
