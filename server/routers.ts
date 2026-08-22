import { COOKIE_NAME } from "@shared/const";
import { getSessionCookieOptions } from "./_core/cookies";
import { systemRouter } from "./_core/systemRouter";
import { healthRouter } from "./_core/health";
import { publicProcedure, router } from "./_core/trpc";
import { inventoryRouter } from "./routers/inventory";

export const appRouter = router({
  system: systemRouter,
  health: healthRouter,
  auth: router({
    me: publicProcedure.query(opts => opts.ctx.user),
    logout: publicProcedure.mutation(({ ctx }) => {
      const cookieOptions = getSessionCookieOptions(ctx.req);
      ctx.res.clearCookie(COOKIE_NAME, { ...cookieOptions, maxAge: -1 });
      return { success: true } as const;
    }),
  }),
  inventory: inventoryRouter,
});

export type AppRouter = typeof appRouter;
