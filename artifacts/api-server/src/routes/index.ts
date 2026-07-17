import { Router, type IRouter } from "express";
import healthRouter from "./health.js";
import tripsRouter from "./trips.js";

const router: IRouter = Router();

router.use(healthRouter);
router.use(tripsRouter);

export default router;
