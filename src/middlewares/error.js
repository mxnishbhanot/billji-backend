import mongoose from 'mongoose';
import { isProduction } from '../config/env.js';
import { ApiError } from '../utils/ApiError.js';

export const notFound = (req, _res, next) => {
  next(new ApiError(404, `Route not found: ${req.originalUrl}`));
};

export const errorHandler = (error, _req, res, _next) => {
  let statusCode = error.statusCode || 500;
  let message = error.message || 'Internal server error';
  let details = error.details || null;

  if (error instanceof mongoose.Error.CastError) {
    statusCode = 400;
    message = 'Invalid resource id';
  }

  if (error.name === 'JsonWebTokenError' || error.name === 'TokenExpiredError') {
    statusCode = 401;
    message = 'Invalid authentication token';
  }

  if (error.code === 11000) {
    statusCode = 409;
    message = 'Duplicate value already exists';
    details = error.keyValue;
  }

  res.status(statusCode).json({
    success: false,
    message,
    details,
    stack: isProduction ? undefined : error.stack
  });
};
