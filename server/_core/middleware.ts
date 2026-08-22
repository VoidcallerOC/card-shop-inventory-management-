// Middleware types and setup
import type { Request, Response, NextFunction, Application } from "express";
import rateLimit from "express-rate-limit";
import helmet from "helmet";
// @ts-ignore - morgan doesn't have types, but it works at runtime
import morgan from "morgan";
import { Config } from "./config";

// Type-safe middleware handlers
type AsyncMiddleware = (req: Request, res: Response, next: NextFunction) => Promise<void> | void;

// Request logging middleware
export function setupRequestLogging(app: Application) {
  if (Config.features.enableLogging) {
    // @ts-ignore - morgan types
    app.use(morgan("combined", {
      skip: (req: Request, res: Response) => {
        // Skip health checks and static files in production
        return (
          process.env.NODE_ENV === "production" &&
          (req.path === "/health" || req.path.startsWith("/static"))
        );
      },
    }));
    console.log("[Middleware] Request logging enabled");
  }
}

// Security headers middleware
export function setupSecurityHeaders(app: Application) {
  if (Config.features.enableSecurityHeaders) {
    // Use helmet for common security headers
    app.use(helmet() as AsyncMiddleware);

    // Configure CSP - disabled by default for Manus platform compatibility
    if (Config.security.helmet.contentSecurityPolicy) {
      app.use(
        helmet.contentSecurityPolicy({
          directives: {
            defaultSrc: ["'self'"],
            scriptSrc: ["'self'", "'unsafe-inline'", "'unsafe-eval'"],
            styleSrc: ["'self'", "'unsafe-inline'"],
            imgSrc: ["'self'", "data:", "blob:"],
            connectSrc: ["'self'"],
          },
        }) as AsyncMiddleware
      );
    }

    // Cross-Origin Resource Policy
    app.use(
      helmet.crossOriginResourcePolicy({
        policy: Config.security.helmet.crossOriginResourcePolicy.policy,
      }) as AsyncMiddleware
    );

    // Additional security headers
    app.use((_req: Request, res: Response, next: NextFunction) => {
      // X-Content-Type-Options
      res.setHeader("X-Content-Type-Options", "nosniff");
      // X-Frame-Options
      res.setHeader("X-Frame-Options", "DENY");
      // Referrer-Policy
      res.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
      // Permissions-Policy
      res.setHeader(
        "Permissions-Policy",
        "camera=(), microphone=(), geolocation=()"
      );
      next();
    });

    console.log("[Middleware] Security headers enabled");
  }
}

// Rate limiting middleware
export function setupRateLimiting(app: Application) {
  if (Config.features.enableRateLimiting) {
    const limiter = rateLimit({
      windowMs: Config.rateLimiting.windowMs,
      max: Config.rateLimiting.maxRequests,
      message: {
        error: Config.rateLimiting.message,
      },
      standardHeaders: true,
      legacyHeaders: false,
      skip: (req: Request) => {
        // Skip rate limiting for health checks
        return req.path === "/health" || req.path === "/api/health";
      },
    });

    app.use(limiter as AsyncMiddleware);
    console.log(
      `[Middleware] Rate limiting enabled: ${Config.rateLimiting.maxRequests} requests per ${Config.rateLimiting.windowMs / 1000 / 60} minutes`
    );
  }
}

// CORS middleware
export function setupCors(app: Application) {
  // CORS is handled by Manus platform, but we add explicit headers for clarity
  app.use((_req: Request, res: Response, next: NextFunction) => {
    res.setHeader("Access-Control-Allow-Origin", Config.security.cors.origin);
    res.setHeader("Access-Control-Allow-Credentials", "true");
    res.setHeader(
      "Access-Control-Allow-Headers",
      "Origin, X-Requested-With, Content-Type, Accept, Authorization"
    );
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS");
    next();
  });
}

// Setup all middleware
export function setupMiddleware(app: Application) {
  setupRequestLogging(app);
  setupSecurityHeaders(app);
  setupRateLimiting(app);
  setupCors(app);
}
