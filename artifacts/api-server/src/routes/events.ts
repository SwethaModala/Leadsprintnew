import { Router, type IRouter, type Request, type Response } from "express";
import { READ_ROLES, requireRole } from "../middlewares/rbac";
import { tenantEventBus } from "../lib/eventBus";
import { logger } from "../lib/logger";

const router: IRouter = Router();

/**
 * Server-Sent Events stream for authenticated operators.
 * Delivers real-time tenant-scoped call updates, status changes, and notifications.
 */
router.get(
  "/events/live",
  (req: Request, res: Response, next) => {
    if (!req.leadSprintUserId || !req.leadSprintBusinessId) {
      res.status(401).json({ error: "Authentication required" });
      return;
    }
    next();
  },
  requireRole(...READ_ROLES),
  (req: Request, res: Response) => {
    const businessId = req.leadSprintBusinessId!;
    const userId = req.leadSprintUserId!;

    logger.debug({ businessId, userId }, "Operator connected to live SSE stream");

    tenantEventBus.registerClient({
      businessId,
      userId,
      req,
      res,
    });
  },
);

export default router;
