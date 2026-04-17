import { Router, type IRouter } from "express";
import healthRouter from "./health.js";
import authRouter from "./auth.js";
import photosRouter from "./photos.js";
import albumsRouter from "./albums.js";
import sharesRouter from "./shares.js";
import albumSharesRouter from "./album-shares.js";
import blobsRouter from "./blobs.js";
import googleImportRouter from "./google-import.js";
import archiveLockRouter from "./archive-lock.js";
import peopleRouter from "./people.js";
import adminRouter from "./admin.js";

const router: IRouter = Router();

router.use(healthRouter);
router.use(authRouter);
router.use(albumSharesRouter);
router.use(photosRouter);
router.use(albumsRouter);
router.use(sharesRouter);
router.use(blobsRouter);
router.use(googleImportRouter);
router.use(archiveLockRouter);
router.use(peopleRouter);
router.use(adminRouter);

export default router;
