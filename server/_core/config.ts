import { ENV } from "./env";

export const Config = {
  database: {
    url: process.env.DATABASE_URL,
    poolSize: parseInt(process.env.DB_POOL_SIZE || "10"),
  },

  storage: {
    maxFileSize: 5 * 1024 * 1024, // 5MB
    allowedTypes: ["image/png", "image/jpeg", "image/webp", "image/gif"] as const,
    basePath: "inventory",
  },

  pagination: {
    defaultPage: 1,
    defaultPageSize: 50,
    maxPageSize: 1000,
  },

  rateLimiting: {
    windowMs: 15 * 60 * 1000, // 15 minutes
    maxRequests: 100,
    message: "Too many requests from this IP, please try again later",
  },

  security: {
    cors: {
      origin: process.env.CORS_ORIGIN || "*",
      credentials: true,
    },
    helmet: {
      contentSecurityPolicy: false, // Disable if using Manus platform
      crossOriginResourcePolicy: { policy: "cross-origin" as const },
    },
  },

  server: {
    port: parseInt(process.env.PORT || "3000"),
    host: process.env.HOST || "localhost",
    allowedHosts: [
      ".manuspre.computer",
      ".manus.computer",
      ".manus-asia.computer",
      ".manuscomputer.ai",
      ".manusvm.computer",
      "localhost",
      "127.0.0.1",
    ] as const,
  },

  // Feature flags
  features: {
    enableLogging: process.env.ENABLE_LOGGING !== "false",
    enableRateLimiting: process.env.ENABLE_RATE_LIMITING !== "false",
    enableSecurityHeaders: process.env.ENABLE_SECURITY_HEADERS !== "false",
  },
} as const;

export type ConfigType = typeof Config;
