import http from 'http';
import app from './app.js';
import { connectDB } from './config/db.js';
import { env } from './config/env.js';
import { initSocket } from './services/socketService.js';

const startServer = async () => {
  try {
    await connectDB();
    const server = http.createServer(app);
    initSocket(server);

    server.listen(env.port, () => {
      console.log(`QuickInvoice API running on port ${env.port}`);
    });
  } catch (error) {
    console.error('Failed to start server:', error.message);
    process.exit(1);
  }
};

startServer();
