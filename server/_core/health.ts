import { sql } from "drizzle-orm";
import { router, publicProcedure } from "./trpc";
import { getDb } from "../db";

export interface HealthStatus {
  status: "healthy" | "unhealthy" | "degraded";
  timestamp: string;
  checks: {
    database: {
      status: "healthy" | "unhealthy";
      latencyMs?: number;
      error?: string;
    };
  };
  version: string;
  uptime: number;
}

async function checkDatabase(): Promise<HealthStatus["checks"]["database"]> {
  const startTime = Date.now();
  try {
    const db = await getDb();
    if (!db) {
      return { status: "unhealthy", error: "Database connection not initialized" };
    }

    // Simple query to test connection
    await db.execute(sql`SELECT 1 as count`);
    const latencyMs = Date.now() - startTime;
    
    return { status: "healthy", latencyMs };
  } catch (error) {
    return {
      status: "unhealthy",
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

export const healthRouter = router({
  check: publicProcedure.query(async (): Promise<HealthStatus> => {
    const startTime = Date.now();
    const [databaseCheck] = await Promise.all([checkDatabase()]);

    const allHealthy = databaseCheck.status === "healthy";
    const status = allHealthy ? "healthy" : databaseCheck.status === "unhealthy" ? "unhealthy" : "degraded";

    return {
      status,
      timestamp: new Date().toISOString(),
      checks: {
        database: databaseCheck,
      },
      version: process.env.npm_package_version || "1.0.0",
      uptime: process.uptime(),
    };
  }),

  // Simple liveness probe
  alive: publicProcedure.query((): { status: "alive" } => {
    return { status: "alive" };
  }),
});

// Express health check endpoint (for k8s/load balancer)
// We use a simple handler without trpc context
export async function handleHealthCheck(req: unknown, res: unknown) {
  const health = await healthRouter.createCaller({ req: {}, res: {} } as any).check();
  const statusCode = health.status === "healthy" ? 200 : 503;
  (res as { set?: (header: string, value: string) => void; status?: (code: number) => { json: (data: unknown) => void } }).set?.("Content-Type", "application/json");
  (res as { status?: (code: number) => { json: (data: unknown) => void } }).status?.(statusCode).json(health);
}
