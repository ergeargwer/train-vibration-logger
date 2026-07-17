import { Router, type IRouter } from "express";
import healthRouter from "./health.js";
import tripsRouter from "./trips.js";
import analysisRouter from "./analysis.js";

const router: IRouter = Router();

router.use(healthRouter);
router.use(tripsRouter);
router.use(analysisRouter);

export default router;
