import { Server } from 'socket.io';
import { env, isProduction } from '../config/env.js';
import Business from '../models/Business.js';
import BusinessMember from '../models/BusinessMember.js';
import User from '../models/User.js';
import { verifyToken } from '../utils/jwt.js';

let io;

const isLocalDevOrigin = (origin) => {
  if (isProduction || !origin) return false;

  try {
    const { hostname } = new URL(origin);
    return hostname === 'localhost' || hostname === '127.0.0.1' || /^192\.168\./.test(hostname) || /^10\./.test(hostname);
  } catch {
    return false;
  }
};

export const initSocket = (server) => {
  io = new Server(server, {
    cors: {
      origin(origin, callback) {
        if (!origin || env.corsOrigins.includes(origin) || isLocalDevOrigin(origin)) {
          return callback(null, true);
        }

        return callback(new Error('Not allowed by CORS'));
      },
      credentials: true
    }
  });

  io.use(async (socket, next) => {
    try {
      const token = socket.handshake.auth?.token;

      if (!token) {
        return next(new Error('Authentication required'));
      }

      const decoded = verifyToken(token);
      const user = await User.findById(decoded.sub).select('_id defaultBusiness');

      if (!user) {
        return next(new Error('Invalid authentication token'));
      }

      let business = null;
      if (user.defaultBusiness) {
        const membership = await BusinessMember.findOne({ business: user.defaultBusiness, user: user._id, status: 'active' }).select('_id');
        business = membership ? await Business.findOne({ _id: user.defaultBusiness, status: 'active' }).select('_id') : null;
      }

      socket.userId = user._id.toString();
      socket.businessId = business?._id?.toString() || null;
      return next();
    } catch (error) {
      return next(error);
    }
  });

  io.on('connection', (socket) => {
    socket.join(`user:${socket.userId}`);
    if (socket.businessId) {
      socket.join(`business:${socket.businessId}`);
    }
  });

  return io;
};

export const emitUserEvent = (userId, event, payload = {}) => {
  if (!io || !userId) {
    return;
  }

  io.to(`user:${userId.toString()}`).emit(event, payload);
};

export const emitBusinessEvent = (businessId, event, payload = {}) => {
  if (!io || !businessId) {
    return;
  }

  io.to(`business:${businessId.toString()}`).emit(event, payload);
};
