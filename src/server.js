import http from 'http';
import app from './app.js';
import { bootstrapBilling } from './bootstrap/billing.js';
import { registerScheduledJobs } from './bootstrap/jobs.js';
import { bootstrapRbac } from './bootstrap/rbac.js';
import { connectDB } from './config/db.js';
import { env } from './config/env.js';
import { startOutboxDispatcher } from './services/eventDispatcher.js';
import { startScheduler } from './services/scheduler.js';
import { initSocket } from './services/socketService.js';

const startServer = async () => {
  try {
    await connectDB();
    await bootstrapRbac();
    await bootstrapBilling();
    const server = http.createServer(app);
    initSocket(server);
    startOutboxDispatcher();
    registerScheduledJobs();
    startScheduler();

    server.listen(env.port, () => {
      console.log(`QuickInvoice API running on port ${env.port}`);
    });

    // Guarded so a double signal can't run the shutdown twice.
    let shuttingDown = false;
    const shutdown = async (signal) => {
      if (shuttingDown) return;
      shuttingDown = true;
      console.log(`Received ${signal}, shutting down...`);
      server.close();
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
